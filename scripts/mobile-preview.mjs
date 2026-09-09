// Serve the mobile renderer from Vite while a *packaged* Argmax keeps the data.
//
// The bridge inside the app serves assets baked into its bundle, so editing
// mobile.css changes nothing there and the app cannot be restarted while it is
// hosting a chat. Vite serves the working tree instead and forwards `/api` to
// the running bridge, so the page gets fresh code and real sessions at once.
// wsTransport builds its socket URL from the page's own origin, so the
// WebSocket has to ride the same proxy.
import { createServer } from "vite";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PORT = Number(process.env.PREVIEW_PORT ?? 5188);
const remotePath = join(homedir(), "Library/Application Support/com.argmax.rs/remote.json");

let remote;
try {
  remote = JSON.parse(readFileSync(remotePath, "utf8"));
} catch {
  console.error(`no remote.json at ${remotePath} — enable Settings → Integrations → Remote access`);
  process.exit(1);
}

const target = `http://127.0.0.1:${remote.port}`;
const res = await fetch(`${target}/mobile.html`).catch(() => null);
if (!res?.ok) {
  console.error(`bridge is not answering on ${target}`);
  process.exit(1);
}

const server = await createServer({
  configFile: "vite.config.ts",
  // Bind v4 explicitly: the default resolves to ::1 only, and the
  // simulator asks for 127.0.0.1.
  server: { host: "127.0.0.1", port: PORT, strictPort: true, proxy: { "/api": { target, ws: true, changeOrigin: true } } }
});
await server.listen();
console.log(`http://127.0.0.1:${PORT}/mobile.html#token=${remote.token}`);
