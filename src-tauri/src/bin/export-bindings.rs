use std::{env, path::PathBuf, process};

fn main() {
    let output = env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("src/shared/bindings.d.ts"));

    if let Err(error) = argmax_lib::export_bindings(&output) {
        eprintln!("argmax: failed to export bindings: {error}");
        process::exit(1);
    }

    println!("wrote {}", output.display());
}
