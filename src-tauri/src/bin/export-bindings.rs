use std::{env, ffi::OsString, path::PathBuf, process};

use argmax_lib::{
    plan_bindings_export, write_bindings_export, BindingsExportChange, BindingsExportTargets,
};

fn main() {
    let mut dry_run = false;
    let mut positional = Vec::<OsString>::new();
    for arg in env::args_os().skip(1) {
        if arg == "--dry-run" {
            dry_run = true;
        } else {
            positional.push(arg);
        }
    }

    let mut paths = positional.into_iter();
    let targets = BindingsExportTargets {
        bindings: paths
            .next()
            .map(PathBuf::from)
            .unwrap_or_else(|| BindingsExportTargets::default().bindings),
        channels: paths
            .next()
            .map(PathBuf::from)
            .unwrap_or_else(|| BindingsExportTargets::default().channels),
        schemas: paths
            .next()
            .map(PathBuf::from)
            .unwrap_or_else(|| BindingsExportTargets::default().schemas),
    };

    if paths.next().is_some() {
        eprintln!(
            "usage: export-bindings [--dry-run] [bindings.d.ts [channels.txt [ipcSchemas.ts]]]"
        );
        process::exit(2);
    }

    let plan = match plan_bindings_export(&targets) {
        Ok(plan) => plan,
        Err(error) => {
            eprintln!("argmax: failed to plan bindings export: {error}");
            process::exit(1);
        }
    };

    if dry_run {
        let mut would_change = false;
        for entry in &plan {
            let line = match entry.change {
                BindingsExportChange::Unchanged => format!("unchanged {}", entry.path.display()),
                BindingsExportChange::WouldCreate => {
                    would_change = true;
                    format!("would create {}", entry.path.display())
                }
                BindingsExportChange::WouldUpdate => {
                    would_change = true;
                    format!("would update {}", entry.path.display())
                }
            };
            println!("{line}");
        }
        process::exit(if would_change { 1 } else { 0 });
    }

    if let Err(error) = write_bindings_export(&targets) {
        eprintln!("argmax: failed to export bindings: {error}");
        process::exit(1);
    }

    for entry in &plan {
        println!("wrote {}", entry.path.display());
    }
}
