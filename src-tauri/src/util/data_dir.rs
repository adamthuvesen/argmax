// Resolve the app data directory, honoring the `ARGMAX_DATA_DIR` override.
//
// The override exists so a second instance can boot against a scratch
// profile — an agent or a test run gets its own database, instance lock,
// attachments, `remote.json`, and logs instead of colliding with the real
// one. Everything derived from the app data dir goes through here; a call
// site that reaches for `app.path().app_data_dir()` directly escapes the
// override and splits the profile.

use std::path::PathBuf;

use tauri::{Manager, Runtime};

pub fn app_data_dir<R: Runtime>(app: &impl Manager<R>) -> tauri::Result<PathBuf> {
    match std::env::var("ARGMAX_DATA_DIR") {
        Ok(raw) if !raw.trim().is_empty() => {
            let dir = PathBuf::from(raw);
            if dir.is_absolute() {
                Ok(dir)
            } else {
                // A relative override would silently depend on the launch
                // cwd; anchor it there explicitly instead.
                Ok(std::env::current_dir()?.join(dir))
            }
        }
        _ => app.path().app_data_dir(),
    }
}
