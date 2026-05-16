import { readFile } from "node:fs/promises";
import path from "node:path";
import { app, protocol, type Protocol } from "electron";
import { ATTACHMENT_PROTOCOL_SCHEME } from "../../shared/attachmentProtocol.js";

export { ATTACHMENT_PROTOCOL_SCHEME } from "../../shared/attachmentProtocol.js";

/** Must be called before `app.whenReady()`. Anything after that is ignored. */
export function registerAttachmentSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ]);
}

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp"
};

/** Registers the URL handler. Must be called after `app.whenReady()`. The
 *  `baseDir` argument scopes which files this handler is allowed to serve —
 *  any request that resolves outside the base returns 403. */
export function registerAttachmentProtocolHandler(
  baseDir: string = path.join(app.getPath("userData"), "attachments"),
  protocolModule: Pick<Protocol, "handle"> = protocol
): void {
  const normalizedBase = path.resolve(baseDir);
  protocolModule.handle(ATTACHMENT_PROTOCOL_SCHEME, async (request) => {
    let resolved: string;
    try {
      const url = new URL(request.url);
      const decoded = decodeURIComponent(url.pathname);
      resolved = path.resolve(decoded);
    } catch {
      return new Response(null, { status: 400 });
    }
    const relative = path.relative(normalizedBase, resolved);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      return new Response(null, { status: 403 });
    }
    try {
      const bytes = await readFile(resolved);
      const ext = path.extname(resolved).toLowerCase();
      const contentType = EXTENSION_TO_MIME[ext] ?? "application/octet-stream";
      // Cast to BodyInit: Node Buffer is a Uint8Array under the hood and is
      // accepted by Electron's Response polyfill. Casting via Uint8Array keeps
      // the lib.dom typings happy without copying.
      const body = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=3600"
        }
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
