# Terminal

User-spawned integrated terminals are independent from provider PTYs. They live in [src-tauri/src/terminal/service.rs](../../src-tauri/src/terminal/service.rs).

IPC:

- `terminal:spawn`
- `terminal:write`
- `terminal:resize`
- `terminal:terminate`
- `terminal:data`
- `terminal:exit`

The service uses `portable-pty`, emits data chunks immediately, and terminates through Rust process-control helpers. Provider sessions use their own PTYs in `providers/`.
