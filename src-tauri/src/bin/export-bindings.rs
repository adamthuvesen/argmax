use std::{env, path::PathBuf, process};

fn main() {
    let mut args = env::args_os().skip(1);
    let bindings_output = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src/shared/bindings.d.ts"));
    let channels_output = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src-tauri/tests/fixtures/channels.txt"));
    let schemas_output = args
        .next()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src/shared/ipcSchemas.ts"));

    if args.next().is_some() {
        eprintln!("usage: export-bindings [bindings.d.ts [channels.txt [ipcSchemas.ts]]]");
        process::exit(2);
    }

    if let Err(error) = argmax_lib::export_bindings(&bindings_output) {
        eprintln!("argmax: failed to export bindings: {error}");
        process::exit(1);
    }
    if let Err(error) = argmax_lib::export_ipc_inventory(&channels_output, &schemas_output) {
        eprintln!("argmax: failed to export IPC inventory: {error}");
        process::exit(1);
    }

    println!("wrote {}", bindings_output.display());
    println!("wrote {}", channels_output.display());
    println!("wrote {}", schemas_output.display());
}
