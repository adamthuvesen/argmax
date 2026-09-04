use std::{collections::BTreeSet, fs, path::Path};

use specta_typescript::{BigIntExportBehavior, Typescript};

fn fixture_channels() -> Vec<&'static str> {
    include_str!("../fixtures/channels.txt")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect()
}

fn source_renames(root: &Path) -> Vec<String> {
    let ipc_dir = root.join("src/ipc");
    let mut channels = Vec::new();

    for entry in fs::read_dir(ipc_dir).expect("read ipc dir") {
        let path = entry.expect("dir entry").path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("rs") {
            continue;
        }
        let contents = fs::read_to_string(path).expect("read ipc module");
        for line in contents.lines() {
            let Some(start) = line.find("#[tauri::command(rename = \"") else {
                continue;
            };
            let rest = &line[start + "#[tauri::command(rename = \"".len()..];
            let end = rest.find('"').expect("rename literal terminates");
            channels.push(rest[..end].to_owned());
        }
    }

    channels
}

#[test]
fn every_command_is_registered() {
    let fixture = fixture_channels();
    assert_eq!(fixture, argmax_lib::ipc::REGISTERED_CHANNELS);

    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let source = source_renames(root);
    assert_eq!(
        source.iter().collect::<BTreeSet<_>>().len(),
        source.len(),
        "duplicate command rename in source"
    );
    assert_eq!(
        fixture.iter().copied().collect::<BTreeSet<_>>(),
        source.iter().map(String::as_str).collect::<BTreeSet<_>>(),
        "source command renames drifted from fixture"
    );

    let bindings = argmax_lib::ipc::specta_builder()
        .export_str(Typescript::default().bigint(BigIntExportBehavior::Number))
        .expect("export bindings");
    let exported_commands = bindings.matches("TAURI_INVOKE(").count();
    assert_eq!(
        exported_commands,
        fixture.len(),
        "tauri-specta collected command count drifted from fixture"
    );
}

/// The committed bindings and secondary channel inventories come from the same
/// exporter, so drift is a test failure rather than a second full
/// `cargo run --bin export-bindings` in CI.
#[test]
fn generated_ipc_files_are_current() {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let files = [
        (
            dir.path().join("bindings.d.ts"),
            root.join("../src/shared/bindings.d.ts"),
        ),
        (
            dir.path().join("channels.txt"),
            root.join("tests/fixtures/channels.txt"),
        ),
        (
            dir.path().join("ipcSchemas.ts"),
            root.join("../src/shared/ipcSchemas.ts"),
        ),
    ];
    argmax_lib::export_bindings(&files[0].0).expect("export bindings");
    argmax_lib::export_ipc_inventory(&files[1].0, &files[2].0).expect("export IPC inventory");

    for (generated_path, committed_path) in files {
        let generated = fs::read_to_string(&generated_path).expect("read generated file");
        let committed = fs::read_to_string(&committed_path).expect("read committed file");
        if generated != committed {
            panic!(
                "{} is stale; run `npm run generate:bindings` and commit the result\n{}",
                committed_path.display(),
                first_difference(&committed, &generated)
            );
        }
    }
}

/// First line where the two files diverge, rendered like a one-hunk diff so a
/// CI log alone explains the failure.
fn first_difference(committed: &str, generated: &str) -> String {
    let mut committed_lines = committed.lines();
    let mut generated_lines = generated.lines();
    let mut line_number = 1;

    loop {
        match (committed_lines.next(), generated_lines.next()) {
            (None, None) => return "files differ only in trailing bytes".to_owned(),
            (committed_line, generated_line) if committed_line != generated_line => {
                return format!(
                    "first difference at line {line_number}:\n- committed: {}\n+ generated: {}",
                    committed_line.unwrap_or("<end of file>"),
                    generated_line.unwrap_or("<end of file>"),
                );
            }
            _ => line_number += 1,
        }
    }
}
