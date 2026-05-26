// Tauri build script.
//
// `tauri-build` regenerates capabilities + ACL caches and copies bundled
// resources into target/.
//
// The TypeScript binding export (via tauri-specta) runs from
// `src/lib.rs::run`, gated on `cfg!(debug_assertions)`. It lives there
// because a build script runs before the rest of the crate is type-checked
// and so cannot import the `#[tauri::command]` functions it needs to
// describe. Running it from `run()` overwrites `src/shared/bindings.d.ts`
// on every debug startup; CI runs the same path via the canary command
// to keep the renderer/backend type contract enforced.
fn main() {
    tauri_build::build();
}
