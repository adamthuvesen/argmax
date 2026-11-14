//! Writes the TypeScript bindings, the channel inventory, and the IPC schema
//! map from `ipc::catalogue`. `npm run generate:bindings` runs it through the
//! `export-bindings` binary; a debug build also runs it on startup.

use std::path::{Path, PathBuf};

use specta_typescript::{BigIntExportBehavior, Typescript};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingsExportChange {
    Unchanged,
    WouldCreate,
    WouldUpdate,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingsExportPlan {
    pub path: PathBuf,
    pub change: BindingsExportChange,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BindingsExportTargets {
    pub bindings: PathBuf,
    pub channels: PathBuf,
    pub schemas: PathBuf,
}

impl Default for BindingsExportTargets {
    fn default() -> Self {
        Self {
            bindings: PathBuf::from("src/shared/bindings.d.ts"),
            channels: PathBuf::from("src-tauri/tests/fixtures/channels.txt"),
            schemas: PathBuf::from("src/shared/ipcSchemas.ts"),
        }
    }
}

pub fn render_bindings() -> Result<String, String> {
    let generated = super::catalogue::specta_builder()
        .export_str(specta_typescript())
        .map_err(|error| error.to_string())?;
    Ok(normalize_generated_bindings(&generated))
}

pub fn render_ipc_channels() -> String {
    super::catalogue::REGISTERED_CHANNELS.join("\n") + "\n"
}

pub fn render_ipc_schemas() -> String {
    let mut schemas = String::from(
        "// Generated from `ipc::catalogue` by `export-bindings`.\n\
         // Rust owns channel names, signatures, and transport availability.\n\n\
         import type { commands } from './bindings.js';\n\n\
         export const IPC_CHANNELS = [\n",
    );
    for channel in super::catalogue::REGISTERED_CHANNELS {
        schemas.push_str("  \"");
        schemas.push_str(channel);
        schemas.push_str("\",\n");
    }
    schemas.push_str("] as const;\n\nexport type IpcChannel = (typeof IPC_CHANNELS)[number];\n");
    schemas.push_str("\ntype Commands = typeof commands;\nexport interface IpcCommands {\n");
    for contract in super::catalogue::COMMAND_CONTRACTS {
        let mut parts = contract.method.split('_');
        let mut method = parts.next().unwrap_or_default().to_owned();
        for part in parts {
            let mut chars = part.chars();
            if let Some(first) = chars.next() {
                method.extend(first.to_uppercase());
                method.extend(chars);
            }
        }
        schemas.push_str(&format!(
            "  \"{}\": Commands[\"{method}\"];\n",
            contract.channel
        ));
    }
    schemas.push_str("}\n\n\
        type OptionalNullable<T> = { [K in keyof T as null extends T[K] ? never : K]: T[K] } &\n\
          { [K in keyof T as null extends T[K] ? K : never]?: T[K] };\n\
        export type IpcInput<C extends IpcChannel> = Parameters<IpcCommands[C]> extends [] ? Record<string, never> : OptionalNullable<Parameters<IpcCommands[C]>[0]>;\n\
        type UnwrapResult<T> = T extends { status: 'ok'; data: infer D } ? D :\n\
          T extends { status: 'error'; error: unknown } ? never : T;\n\
        export type IpcOutput<C extends IpcChannel> = UnwrapResult<Awaited<ReturnType<IpcCommands[C]>>>;\n\
        export type IpcArguments<C extends IpcChannel> = Record<string, never> extends IpcInput<C> ? [input?: IpcInput<C>] : [input: IpcInput<C>];\n");
    schemas
}

pub fn plan_bindings_export(
    targets: &BindingsExportTargets,
) -> Result<Vec<BindingsExportPlan>, String> {
    let rendered = [
        (targets.bindings.clone(), render_bindings()?),
        (targets.channels.clone(), render_ipc_channels()),
        (targets.schemas.clone(), render_ipc_schemas()),
    ];
    rendered
        .into_iter()
        .map(|(path, content)| {
            Ok(BindingsExportPlan {
                change: file_export_change(&path, &content)?,
                path,
            })
        })
        .collect()
}

pub fn write_bindings_export(targets: &BindingsExportTargets) -> Result<(), String> {
    std::fs::write(&targets.bindings, render_bindings()?).map_err(|error| error.to_string())?;
    std::fs::write(&targets.channels, render_ipc_channels()).map_err(|error| error.to_string())?;
    std::fs::write(&targets.schemas, render_ipc_schemas()).map_err(|error| error.to_string())
}

pub fn export_bindings(path: impl AsRef<Path>) -> Result<(), String> {
    std::fs::write(path, render_bindings()?).map_err(|error| error.to_string())
}

pub fn export_ipc_inventory(
    channels_path: impl AsRef<Path>,
    schemas_path: impl AsRef<Path>,
) -> Result<(), String> {
    std::fs::write(channels_path, render_ipc_channels()).map_err(|error| error.to_string())?;
    std::fs::write(schemas_path, render_ipc_schemas()).map_err(|error| error.to_string())
}

fn normalize_generated_bindings(generated: &str) -> String {
    // Specta leaves spaces before newlines in documented object fields.
    // Normalize its output so generated bindings pass the whitespace gate.
    generated
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn file_export_change(path: &Path, rendered: &str) -> Result<BindingsExportChange, String> {
    match std::fs::read_to_string(path) {
        Ok(existing) if existing == rendered => Ok(BindingsExportChange::Unchanged),
        Ok(_) => Ok(BindingsExportChange::WouldUpdate),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(BindingsExportChange::WouldCreate)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn specta_typescript() -> Typescript {
    Typescript::default().bigint(BigIntExportBehavior::Number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bindings_export_dry_run_leaves_committed_files_unchanged() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"));
        let targets = BindingsExportTargets {
            bindings: root.join("../src/shared/bindings.d.ts"),
            channels: root.join("tests/fixtures/channels.txt"),
            schemas: root.join("../src/shared/ipcSchemas.ts"),
        };
        let plan = plan_bindings_export(&targets).expect("plan export");
        assert!(
            plan.iter()
                .all(|entry| entry.change == BindingsExportChange::Unchanged),
            "expected committed IPC exports to be current: {plan:?}"
        );
    }

    #[test]
    fn bindings_export_dry_run_reports_changes_without_writing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bindings_path = dir.path().join("bindings.d.ts");
        std::fs::write(&bindings_path, "stale\n").expect("write stale bindings");

        let targets = BindingsExportTargets {
            bindings: bindings_path.clone(),
            channels: dir.path().join("channels.txt"),
            schemas: dir.path().join("ipcSchemas.ts"),
        };
        let plan = plan_bindings_export(&targets).expect("plan export");
        assert_eq!(plan[0].change, BindingsExportChange::WouldUpdate);
        assert_eq!(plan[1].change, BindingsExportChange::WouldCreate);
        assert_eq!(plan[2].change, BindingsExportChange::WouldCreate);
        assert_eq!(
            std::fs::read_to_string(&bindings_path).expect("read bindings"),
            "stale\n"
        );
    }
}
