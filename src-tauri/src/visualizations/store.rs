use super::{
    document, VisualizationArtifact, VisualizationControlValues, VisualizationFormat,
    VisualizationMode, VisualizationRead, VisualizationWidgetState,
};
use crate::error::{ArgmaxError, ArgmaxResult};
use base64::{engine::general_purpose::STANDARD, Engine};
use regex::Regex;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};
use uuid::Uuid;

pub const HTML_BYTE_CAP: usize = 1_000_000;
const IMAGE_BYTE_CAP: usize = 10 * 1024 * 1024;
const SNAPSHOT_BYTE_CAP: usize = 25 * 1024 * 1024;
const STATE_BYTE_CAP: usize = 16 * 1024;

#[derive(Clone)]
pub struct VisualizationStore {
    root: PathBuf,
}

fn failure(message: impl Into<String>) -> ArgmaxError {
    ArgmaxError::service("VISUALIZATION_INVALID", message)
}
fn io_error(error: std::io::Error) -> ArgmaxError {
    ArgmaxError::service("VISUALIZATION_STORAGE", error.to_string())
}

impl VisualizationStore {
    pub fn from_data_dir(data_dir: &Path) -> Self {
        Self {
            root: data_dir.join("attachments"),
        }
    }

    fn session_dir(&self, session: &str) -> ArgmaxResult<PathBuf> {
        if session.is_empty()
            || !Path::new(session)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
            || Path::new(session).components().count() != 1
        {
            return Err(failure("Invalid visualization session ID"));
        }
        let dir = self.root.join(session).join("visualizations");
        for path in [self.root.clone(), self.root.join(session), dir.clone()] {
            if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
                return Err(failure("Visualization storage cannot contain symlinks"));
            }
        }
        Ok(dir)
    }

    fn artifact_dir(&self, session: &str, id: &str) -> ArgmaxResult<PathBuf> {
        let id = Uuid::parse_str(id).map_err(|_| failure("Invalid visualization artifact ID"))?;
        let dir = self.session_dir(session)?.join(id.to_string());
        if fs::symlink_metadata(&dir).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err(failure("Visualization artifact cannot be a symlink"));
        }
        Ok(dir)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn ingest(
        &self,
        session: &str,
        html: Option<&str>,
        path: Option<&Path>,
        roots: &[PathBuf],
        title: Option<String>,
        summary: Option<String>,
        mode: Option<VisualizationMode>,
        stable: bool,
        reference_id: Option<&str>,
    ) -> ArgmaxResult<VisualizationArtifact> {
        if html.is_some() == path.is_some() {
            return Err(failure("Provide exactly one of html or path"));
        }
        if path.is_some_and(|path| !path.is_absolute()) {
            return Err(failure("Visualization source path must be absolute"));
        }
        if reference_id.is_some_and(|value| value.is_empty() || value.len() > 1024) {
            return Err(failure(
                "Visualization reference ID must contain 1–1024 bytes",
            ));
        }
        let title = title.unwrap_or_else(|| "Visualization".into());
        let summary = summary.unwrap_or_else(|| title.clone());
        if title.trim().is_empty()
            || title.chars().count() > 250
            || summary.trim().is_empty()
            || summary.chars().count() > 4000
        {
            return Err(failure(
                "Title must contain 1–250 characters and summary 1–4000 characters",
            ));
        }
        let stable_id = if stable {
            let mut digest = Sha256::new();
            digest.update(
                path.map(|value| value.to_string_lossy().into_owned())
                    .unwrap_or_else(|| html.unwrap_or_default().to_owned())
                    .as_bytes(),
            );
            digest.update(
                serde_json::to_vec(&(&title, &summary, &mode))
                    .map_err(|e| failure(e.to_string()))?,
            );
            if let Some(reference) = reference_id {
                digest.update(serde_json::to_vec(reference).map_err(|e| failure(e.to_string()))?);
            }
            let hash = digest.finalize();
            let mut bytes = [0; 16];
            bytes.copy_from_slice(&hash[..16]);
            Some(Uuid::from_bytes(bytes).to_string())
        } else {
            None
        };
        if let Some(id) = stable_id.as_deref() {
            if self.artifact_dir(session, id)?.exists() {
                return self.read(session, id).map(|read| read.artifact);
            }
        }
        let (format, source, dependencies) = if let Some(html) = html {
            validate_html(html)?;
            let (source, deps) = snapshot_html(html, None, roots)?;
            (VisualizationFormat::Html, source, deps)
        } else {
            let path = confined_path(path.expect("validated source"), roots)?;
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or_default()
                .to_ascii_lowercase();
            if matches!(extension.as_str(), "html" | "htm") {
                let bytes = bounded_read(&path, HTML_BYTE_CAP)?;
                let html = String::from_utf8(bytes)
                    .map_err(|_| failure("Visualization HTML must be UTF-8"))?;
                validate_html(&html)?;
                let (source, deps) = snapshot_html(&html, path.parent(), roots)?;
                (VisualizationFormat::Html, source, deps)
            } else {
                (
                    VisualizationFormat::Image,
                    image_data_uri(&path)?,
                    Vec::new(),
                )
            }
        };
        if source.len() > SNAPSHOT_BYTE_CAP {
            return Err(failure("Visualization snapshot exceeds 25 MiB"));
        }
        let id = stable_id.unwrap_or_else(|| Uuid::new_v4().to_string());
        let artifact = VisualizationArtifact {
            id: id.clone(),
            session_id: session.into(),
            title,
            summary,
            format,
            mode,
            runtime_version: document::runtime_version(),
            external_dependencies: dependencies,
        };
        let dir = self.artifact_dir(session, &id)?;
        if dir.exists() {
            return self.read(session, &id).map(|read| read.artifact);
        }
        let parent = self.session_dir(session)?;
        fs::create_dir_all(&parent).map_err(io_error)?;
        let temporary = tempfile::tempdir_in(&parent).map_err(io_error)?;
        fs::write(temporary.path().join("source"), source).map_err(io_error)?;
        fs::write(
            temporary.path().join("artifact.json"),
            serde_json::to_vec(&artifact).map_err(|e| failure(e.to_string()))?,
        )
        .map_err(io_error)?;
        match fs::rename(temporary.path(), &dir) {
            Ok(()) => {}
            Err(_) if dir.exists() => return self.read(session, &id).map(|read| read.artifact),
            Err(error) => return Err(io_error(error)),
        }
        Ok(artifact)
    }

    pub fn artifact(&self, session: &str, id: &str) -> ArgmaxResult<VisualizationArtifact> {
        let dir = self.artifact_dir(session, id)?;
        let artifact: VisualizationArtifact = serde_json::from_slice(&bounded_read(
            &dir.join("artifact.json"),
            SNAPSHOT_BYTE_CAP,
        )?)
        .map_err(|error| failure(error.to_string()))?;
        if artifact.session_id != session || artifact.id != id {
            return Err(failure("Visualization ownership does not match"));
        }
        Ok(artifact)
    }

    pub fn read(&self, session: &str, id: &str) -> ArgmaxResult<VisualizationRead> {
        let dir = self.artifact_dir(session, id)?;
        let artifact = self.artifact(session, id)?;
        let source = String::from_utf8(bounded_read(&dir.join("source"), SNAPSHOT_BYTE_CAP)?)
            .map_err(|_| failure("Invalid stored visualization source"))?;
        let state = if dir.join("state.json").exists() {
            serde_json::from_slice(&bounded_read(&dir.join("state.json"), STATE_BYTE_CAP)?)
                .map_err(|e| failure(e.to_string()))?
        } else {
            VisualizationWidgetState::default()
        };
        let control_values = self.controls(session, id)?;
        let fragment = match artifact.format {
            VisualizationFormat::Html => source.clone(),
            VisualizationFormat::Image => format!(
                "<img src=\"{source}\" alt=\"{}\" style=\"max-width:100%;height:auto\">",
                escape_attribute(&artifact.summary)
            ),
        };
        let document = document::build_document(
            &fragment,
            &json!({"instanceId":id,"appearance":{"dark":false,"variables":{}},"state":state,"controlValues":control_values,"capabilities":{"controls":true}}),
        );
        Ok(VisualizationRead {
            artifact,
            source,
            document,
            state,
            control_values,
        })
    }

    pub fn clone_session(&self, source_session: &str, target_session: &str) -> ArgmaxResult<()> {
        let source = self.session_dir(source_session)?;
        let entries = match fs::read_dir(&source) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(io_error(error)),
        };
        let target = self.session_dir(target_session)?;
        for entry in entries {
            let entry = entry.map_err(io_error)?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".tmp") {
                continue;
            }
            Uuid::parse_str(&name)
                .map_err(|_| failure("Invalid visualization directory during history copy"))?;
            let mut artifact = self.artifact(source_session, &name)?;
            artifact.session_id = target_session.into();
            let source_bytes = bounded_read(&entry.path().join("source"), SNAPSHOT_BYTE_CAP)?;
            let destination = self.artifact_dir(target_session, &name)?;
            if destination.exists() {
                let existing = self.artifact(target_session, &name)?;
                if serde_json::to_value(&existing).map_err(|e| failure(e.to_string()))?
                    != serde_json::to_value(&artifact).map_err(|e| failure(e.to_string()))?
                    || bounded_read(&destination.join("source"), SNAPSHOT_BYTE_CAP)? != source_bytes
                {
                    return Err(failure(
                        "Visualization history copy conflicts with an existing snapshot",
                    ));
                }
                continue;
            }
            fs::create_dir_all(&target).map_err(io_error)?;
            let temporary = tempfile::tempdir_in(&target).map_err(io_error)?;
            fs::write(temporary.path().join("source"), source_bytes).map_err(io_error)?;
            fs::write(
                temporary.path().join("artifact.json"),
                serde_json::to_vec(&artifact).map_err(|e| failure(e.to_string()))?,
            )
            .map_err(io_error)?;
            let controls = entry.path().join("controls.json");
            if controls.exists() {
                fs::write(
                    temporary.path().join("controls.json"),
                    bounded_read(&controls, STATE_BYTE_CAP)?,
                )
                .map_err(io_error)?;
            }
            let state = entry.path().join("state.json");
            if state.exists() {
                fs::write(
                    temporary.path().join("state.json"),
                    bounded_read(&state, STATE_BYTE_CAP)?,
                )
                .map_err(io_error)?;
            }
            fs::rename(temporary.path(), &destination).map_err(io_error)?;
        }
        Ok(())
    }

    pub fn controls(&self, session: &str, id: &str) -> ArgmaxResult<VisualizationControlValues> {
        self.artifact(session, id)?;
        let path = self.artifact_dir(session, id)?.join("controls.json");
        let values = if path.exists() {
            serde_json::from_slice(&bounded_read(&path, STATE_BYTE_CAP)?)
                .map_err(|error| failure(error.to_string()))?
        } else {
            VisualizationControlValues::new()
        };
        validate_controls(&values)?;
        Ok(values)
    }
    pub fn set_controls(
        &self,
        session: &str,
        id: &str,
        values: VisualizationControlValues,
    ) -> ArgmaxResult<VisualizationControlValues> {
        self.artifact(session, id)?;
        validate_controls(&values)?;
        let mut file =
            tempfile::NamedTempFile::new_in(self.artifact_dir(session, id)?).map_err(io_error)?;
        file.write_all(&serde_json::to_vec(&values).map_err(|error| failure(error.to_string()))?)
            .map_err(io_error)?;
        file.persist(self.artifact_dir(session, id)?.join("controls.json"))
            .map_err(|error| io_error(error.error))?;
        Ok(values)
    }

    pub fn set_state(
        &self,
        session: &str,
        id: &str,
        state: VisualizationWidgetState,
    ) -> ArgmaxResult<VisualizationWidgetState> {
        self.artifact(session, id)?;
        let bytes = serde_json::to_vec(&state).map_err(|e| failure(e.to_string()))?;
        if bytes.len() > STATE_BYTE_CAP {
            return Err(failure("Widget state exceeds 16 KiB"));
        }
        let dir = self.artifact_dir(session, id)?;
        let mut file = tempfile::NamedTempFile::new_in(&dir).map_err(io_error)?;
        file.write_all(&bytes).map_err(io_error)?;
        file.persist(dir.join("state.json"))
            .map_err(|e| io_error(e.error))?;
        Ok(state)
    }
}

fn validate_controls(values: &VisualizationControlValues) -> ArgmaxResult<()> {
    if values.len() > 384
        || values.iter().any(|(id, value)| {
            id.is_empty()
                || id.chars().count() > 250
                || match value {
                    serde_json::Value::Bool(_) => false,
                    serde_json::Value::Number(number) => {
                        number.as_f64().is_none_or(|number| !number.is_finite())
                    }
                    serde_json::Value::String(text) => text.chars().count() > 250,
                    _ => true,
                }
        })
    {
        return Err(failure("Controls accept at most 384 named finite numbers, booleans or strings of at most 250 characters"));
    }
    if serde_json::to_vec(values)
        .map_err(|error| failure(error.to_string()))?
        .len()
        > STATE_BYTE_CAP
    {
        return Err(failure("Control values exceed 16 KiB"));
    }
    Ok(())
}

pub(crate) fn escape_attribute(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}
fn validate_html(html: &str) -> ArgmaxResult<()> {
    if html.trim().is_empty() || html.len() > HTML_BYTE_CAP {
        Err(failure("Visualization HTML must contain 1–1000000 bytes"))
    } else {
        Ok(())
    }
}
fn bounded_read(path: &Path, cap: usize) -> ArgmaxResult<Vec<u8>> {
    if fs::symlink_metadata(path)
        .map_err(io_error)?
        .file_type()
        .is_symlink()
    {
        return Err(failure("Stored visualization files cannot be symlinks"));
    }
    let mut bytes = Vec::new();
    fs::File::open(path)
        .map_err(io_error)?
        .take((cap + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() > cap {
        return Err(failure(format!("Visualization file exceeds {cap} bytes")));
    }
    Ok(bytes)
}
fn confined_path(path: &Path, roots: &[PathBuf]) -> ArgmaxResult<PathBuf> {
    let canonical = fs::canonicalize(path).map_err(io_error)?;
    if roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .any(|root| canonical.starts_with(root))
    {
        Ok(canonical)
    } else {
        Err(failure(
            "Visualization file is outside the owning checkout and visualization roots",
        ))
    }
}
fn image_data_uri(path: &Path) -> ArgmaxResult<String> {
    let bytes = bounded_read(path, IMAGE_BYTE_CAP)?;
    let format = image::guess_format(&bytes)
        .map_err(|_| failure("Visualization image is not a supported image"))?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        _ => {
            return Err(failure(
                "Visualization images support PNG, JPEG, GIF and WebP",
            ))
        }
    };
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(&bytes), format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(16384);
    limits.max_image_height = Some(16384);
    limits.max_alloc = Some(128 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().map_err(|_| {
        failure("Visualization image bytes are invalid or dimensions exceed limits")
    })?;
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
fn snapshot_html(
    html: &str,
    parent: Option<&Path>,
    roots: &[PathBuf],
) -> ArgmaxResult<(String, Vec<String>)> {
    snapshot_html_with_cap(html, parent, roots, SNAPSHOT_BYTE_CAP)
}

fn append_snapshot(output: &mut String, value: &str, cap: usize) -> ArgmaxResult<()> {
    if output.len().saturating_add(value.len()) > cap {
        return Err(failure("Visualization snapshot exceeds its byte limit"));
    }
    output.push_str(value);
    Ok(())
}

fn snapshot_html_with_cap(
    html: &str,
    parent: Option<&Path>,
    roots: &[PathBuf],
    cap: usize,
) -> ArgmaxResult<(String, Vec<String>)> {
    if html.len() > cap {
        return Err(failure("Visualization snapshot exceeds its byte limit"));
    }
    let mut cache = std::collections::HashMap::<PathBuf, String>::new();
    let mut cache_bytes = 0usize;
    let mut expanded_bytes = html.len();
    let mut image = |path: &str| -> ArgmaxResult<Option<String>> {
        if path.starts_with("http:")
            || path.starts_with("https:")
            || path.starts_with("data:")
            || path.starts_with("blob:")
            || path.starts_with("//")
        {
            return Ok(None);
        }
        let path_value = Path::new(path);
        let resolved = if path_value.is_absolute() {
            path_value.to_path_buf()
        } else {
            parent
                .ok_or_else(|| failure("Relative local images require a file source"))?
                .join(path_value)
        };
        let resolved = confined_path(&resolved, roots)?;
        if !cache.contains_key(&resolved) {
            let data = image_data_uri(&resolved)?;
            if cache_bytes.saturating_add(data.len()) > cap {
                return Err(failure(
                    "Visualization image snapshots exceed the byte limit",
                ));
            }
            cache_bytes += data.len();
            cache.insert(resolved.clone(), data);
        }
        let data = &cache[&resolved];
        let growth = data.len().saturating_sub(path.len());
        if expanded_bytes.saturating_add(growth) > cap {
            return Err(failure("Visualization snapshot exceeds its byte limit"));
        }
        expanded_bytes += growth;
        Ok(Some(data.clone()))
    };
    let overflow = std::cell::Cell::new(false);
    let mut html_snapshot = Vec::with_capacity(html.len());
    {
        let mut rewriter = lol_html::HtmlRewriter::new(
            lol_html::Settings::new().append_element_content_handler(lol_html::element!(
                "img, source",
                |element| {
                    if overflow.get() {
                        return Err(failure("Visualization snapshot exceeds its byte limit").into());
                    }
                    if let Some(path) = element.get_attribute("src") {
                        if let Some(data) = image(&path)? {
                            element.set_attribute("src", &data)?;
                        }
                    }
                    if let Some(srcset) = element.get_attribute("srcset") {
                        if !srcset.trim_start().starts_with("data:") {
                            let mut entries = String::new();
                            for entry in srcset.split(',') {
                                let mut words = entry.split_whitespace();
                                let path = words
                                    .next()
                                    .ok_or_else(|| failure("Empty visualization srcset entry"))?;
                                let source = image(path)?.unwrap_or_else(|| path.into());
                                if !entries.is_empty() {
                                    append_snapshot(&mut entries, ", ", cap)?
                                }
                                append_snapshot(&mut entries, &source, cap)?;
                                for descriptor in words {
                                    append_snapshot(&mut entries, " ", cap)?;
                                    append_snapshot(&mut entries, descriptor, cap)?;
                                }
                            }
                            element.set_attribute("srcset", &entries)?;
                        }
                    }
                    Ok(())
                }
            )),
            |chunk: &[u8]| {
                if html_snapshot.len().saturating_add(chunk.len()) > cap {
                    overflow.set(true)
                } else if !overflow.get() {
                    html_snapshot.extend_from_slice(chunk)
                }
            },
        );
        rewriter.write(html.as_bytes()).map_err(|error| {
            failure(format!("Could not snapshot visualization images: {error}"))
        })?;
        rewriter.end().map_err(|error| {
            failure(format!("Could not snapshot visualization images: {error}"))
        })?;
    }
    if overflow.get() {
        return Err(failure("Visualization snapshot exceeds its byte limit"));
    }
    let html = String::from_utf8(html_snapshot)
        .map_err(|_| failure("Visualization snapshot is not UTF-8"))?;
    // Local images in quoted CSS URLs and JavaScript literals use the same snapshot budget.
    let pattern = Regex::new(
        r#"(?P<quote>[\"'])(?P<path>[^\"'<>\r\n]+\.(?:png|jpe?g|gif|webp))(?P<end>[\"'])"#,
    )
    .expect("valid image path expression");
    let mut source = String::with_capacity(html.len());
    let mut offset = 0;
    for capture in pattern.captures_iter(&html) {
        let value = capture.name("path").expect("image path");
        if let Some(data) = image(value.as_str())? {
            append_snapshot(&mut source, &html[offset..value.start()], cap)?;
            append_snapshot(&mut source, &data, cap)?;
            offset = value.end();
        }
    }
    append_snapshot(&mut source, &html[offset..], cap)?;
    let css = Regex::new(r#"url\(\s*([^\s"'()]+\.(?:png|jpe?g|gif|webp))\s*\)"#)
        .expect("valid CSS image expression");
    let mut css_source = String::with_capacity(source.len());
    let mut offset = 0;
    for capture in css.captures_iter(&source) {
        let value = capture.get(1).expect("CSS image path");
        if let Some(data) = image(value.as_str())? {
            append_snapshot(&mut css_source, &source[offset..value.start()], cap)?;
            append_snapshot(&mut css_source, &data, cap)?;
            offset = value.end();
        }
    }
    append_snapshot(&mut css_source, &source[offset..], cap)?;
    let remote =
        Regex::new(r#"https?://[^\s\"'<>\)]+"#).expect("valid external dependency expression");
    let dependencies = remote
        .find_iter(&css_source)
        .map(|value| value.as_str().to_string())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    Ok((css_source, dependencies))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn snapshots_are_immutable_owned_and_pruned_with_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let store = VisualizationStore::from_data_dir(dir.path());
        let root = dir.path().join("checkout");
        fs::create_dir(&root).unwrap();
        let path = root.join("chart.html");
        fs::write(&path, "<p>original</p>").unwrap();
        let artifact = store
            .ingest(
                "session",
                None,
                Some(&path),
                std::slice::from_ref(&root),
                None,
                None,
                None,
                true,
                None,
            )
            .unwrap();
        fs::write(&path, "changed").unwrap();
        fs::remove_dir_all(&root).unwrap();
        assert_eq!(
            store.read("session", &artifact.id).unwrap().source,
            "<p>original</p>"
        );
        assert!(store.read("other", &artifact.id).is_err());
        crate::attachments::store::AttachmentStore::from_data_dir(dir.path())
            .prune_session(
                &crate::ipc::validation::SessionId::try_from("session".to_string()).unwrap(),
            )
            .unwrap();
        assert!(store.read("session", &artifact.id).is_err());
    }
    #[test]
    fn validates_limits_and_state_and_stable_imports() {
        let dir = tempfile::tempdir().unwrap();
        let store = VisualizationStore::from_data_dir(dir.path());
        assert!(store
            .ingest(
                "../outside",
                Some("ok"),
                None,
                &[],
                None,
                None,
                None,
                false,
                None
            )
            .is_err());
        assert!(store
            .ingest(
                "s",
                Some(&"x".repeat(HTML_BYTE_CAP + 1)),
                None,
                &[],
                None,
                None,
                None,
                false,
                None
            )
            .is_err());
        let a = store
            .ingest(
                "s",
                Some("<p>ok</p>"),
                None,
                &[],
                None,
                None,
                None,
                true,
                None,
            )
            .unwrap();
        let b = store
            .ingest(
                "s",
                Some("<p>ok</p>"),
                None,
                &[],
                None,
                None,
                None,
                true,
                None,
            )
            .unwrap();
        assert_eq!(a.id, b.id);
        let state = VisualizationWidgetState {
            model_content: json!({"filter":2}),
            private_content: json!({"secret":"local"}),
        };
        store.set_state("s", &a.id, state).unwrap();
        assert_eq!(
            store.read("s", &a.id).unwrap().state.model_content["filter"],
            2
        );
        assert!(store
            .set_state(
                "s",
                &a.id,
                VisualizationWidgetState {
                    model_content: json!("x".repeat(STATE_BYTE_CAP)),
                    private_content: json!(null)
                }
            )
            .is_err());
    }
    #[test]
    fn bounded_html_and_css_image_expansion_rejects_repeated_images() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plot.png");
        fs::write(&path,STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=").unwrap()).unwrap();
        for source in [
            "<img src='plot.png'>".repeat(500),
            format!(
                "<img srcset='{}'>",
                std::iter::repeat_n("plot.png 1x", 500)
                    .collect::<Vec<_>>()
                    .join(",")
            ),
            format!(
                "<style>{}</style>",
                ".x{background:url(plot.png)}".repeat(500)
            ),
        ] {
            assert!(snapshot_html_with_cap(
                &source,
                Some(dir.path()),
                &[dir.path().to_path_buf()],
                32 * 1024
            )
            .is_err());
        }
        let mut output = String::from("small");
        assert!(append_snapshot(&mut output, "too large", 8).is_err());
        assert_eq!(output, "small");
    }
    #[test]
    fn copied_snapshots_and_private_state_survive_original_session_deletion() {
        let dir = tempfile::tempdir().unwrap();
        let store = VisualizationStore::from_data_dir(dir.path());
        let file = dir.path().join("legacy.html");
        fs::write(&file, "<p>saved</p>").unwrap();
        let artifact = store
            .ingest(
                "source",
                None,
                Some(&file),
                &[dir.path().to_path_buf()],
                None,
                None,
                None,
                true,
                None,
            )
            .unwrap();
        store
            .set_state(
                "source",
                &artifact.id,
                VisualizationWidgetState {
                    model_content: json!({"filter":1}),
                    private_content: json!({"local":2}),
                },
            )
            .unwrap();
        store.clone_session("source", "target").unwrap();
        fs::remove_file(&file).unwrap();
        fs::remove_dir_all(dir.path().join("attachments/source")).unwrap();
        let cached = store
            .ingest(
                "target",
                None,
                Some(&file),
                &[],
                None,
                None,
                None,
                true,
                None,
            )
            .unwrap();
        assert_eq!(cached.id, artifact.id);
        assert_eq!(cached.session_id, "target");
        assert_eq!(
            store
                .read("target", &artifact.id)
                .unwrap()
                .state
                .private_content["local"],
            2
        );
        assert!(store.read("other", &artifact.id).is_err());
    }
    #[test]
    fn reference_identity_distinguishes_new_answers_and_controls_persist() {
        let dir = tempfile::tempdir().unwrap();
        let store = VisualizationStore::from_data_dir(dir.path());
        let file = dir.path().join("chart.html");
        fs::write(&file, "first").unwrap();
        let first = store
            .ingest(
                "s",
                None,
                Some(&file),
                &[dir.path().to_path_buf()],
                None,
                None,
                None,
                true,
                Some("message-1:0"),
            )
            .unwrap();
        fs::write(&file, "second").unwrap();
        let second = store
            .ingest(
                "s",
                None,
                Some(&file),
                &[dir.path().to_path_buf()],
                None,
                None,
                None,
                true,
                Some("message-2:0"),
            )
            .unwrap();
        assert_ne!(first.id, second.id);
        assert_eq!(store.read("s", &first.id).unwrap().source, "first");
        assert_eq!(store.read("s", &second.id).unwrap().source, "second");
        let values = std::collections::BTreeMap::from([
            ("count".into(), json!(4)),
            ("label".into(), json!("variant")),
            ("enabled".into(), json!(true)),
        ]);
        store.set_controls("s", &first.id, values.clone()).unwrap();
        assert_eq!(store.read("s", &first.id).unwrap().control_values, values);
        store.clone_session("s", "child").unwrap();
        assert_eq!(
            store.read("child", &first.id).unwrap().control_values,
            values
        );
        for invalid in [
            std::collections::BTreeMap::from([("object".into(), json!({"bad":1}))]),
            std::collections::BTreeMap::from([("label".into(), json!("x".repeat(251)))]),
            std::collections::BTreeMap::from([("".into(), json!(1))]),
        ] {
            assert!(store.set_controls("s", &first.id, invalid).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn confines_sources_and_rejects_symlink_escapes_and_non_images() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("visualizations");
        fs::create_dir(&root).unwrap();
        let outside = dir.path().join("secret.html");
        fs::write(&outside, "secret").unwrap();
        let link = root.join("escape.html");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let store = VisualizationStore::from_data_dir(dir.path());
        assert!(store
            .ingest(
                "s",
                None,
                Some(&link),
                std::slice::from_ref(&root),
                None,
                None,
                None,
                false,
                None
            )
            .is_err());
        let sibling = dir.path().join("visualizations-other");
        fs::create_dir(&sibling).unwrap();
        let file = sibling.join("outside.html");
        fs::write(&file, "outside").unwrap();
        assert!(store
            .ingest(
                "s",
                None,
                Some(&file),
                std::slice::from_ref(&root),
                None,
                None,
                None,
                false,
                None
            )
            .is_err());
        let text = root.join("text.txt");
        fs::write(&text, "text").unwrap();
        assert!(store
            .ingest(
                "s",
                None,
                Some(&text),
                &[root],
                None,
                None,
                None,
                false,
                None
            )
            .is_err());
    }
    #[test]
    fn embeds_images_and_rejects_invalid_or_escaped_paths() {
        let dir = tempfile::tempdir().unwrap();
        let png = dir.path().join("plot.png");
        let bytes=STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=").unwrap();
        fs::write(&png, bytes).unwrap();
        let (source, deps) = snapshot_html(
            "<img src='plot.png' srcset='plot.png 1x, plot.png 2x'><style>.a{background:url(plot.png)}.b{background:url('plot.png')}</style><script>const img='plot.png';</script><script src='https://cdn.jsdelivr.net/x.js'></script>",
            Some(dir.path()),
            &[dir.path().to_path_buf()],
        )
        .unwrap();
        assert!(source.matches("data:image/png;base64,").count() >= 6);
        assert_eq!(deps, vec!["https://cdn.jsdelivr.net/x.js"]);
        fs::write(&png, "not an image").unwrap();
        assert!(image_data_uri(&png).is_err());
        assert!(confined_path(&png, &[]).is_err());
    }
}
