use std::{collections::BTreeSet, fs, path::Path};

use specta_typescript::{BigIntExportBehavior, Typescript};

fn fixture_channels() -> Vec<&'static str> {
    include_str!("fixtures/channels.txt")
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
    assert_eq!(
        fixture.len(),
        72,
        "fixture should list every stable channel"
    );

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
