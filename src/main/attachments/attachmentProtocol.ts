import { readFile, realpath } from "node:fs/promises";
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

function isUnderBase(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** File paths must live strictly inside `base`, not at the base directory itself. */
function isFileUnderBase(base: string, candidate: string): boolean {
  const rel = path.relative(base, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

async function isWithinBase(base: string, targetPath: string): Promise<boolean> {
  let candidate = path.resolve(targetPath);
  try {
    candidate = await realpath(targetPath);
  } catch {
    let dir = path.dirname(targetPath);
    for (;;) {
      try {
        candidate = await realpath(dir);
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) {
          return isUnderBase(base, path.resolve(targetPath));
        }
        dir = parent;
      }
    }
  }
  return isUnderBase(base, candidate);
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
  protocolModule.handle(ATTACHMENT_PROTOCOL_SCHEME, async (request) => {
    let normalizedBase: string;
    try {
      normalizedBase = await realpath(path.resolve(baseDir));
    } catch {
      return new Response(null, { status: 403 });
    }
    let resolved: string;
    try {
      const url = new URL(request.url);
      const decoded = decodeURIComponent(url.pathname);
      resolved = path.resolve(decoded);
    } catch {
      return new Response(null, { status: 400 });
    }
    if (!(await isWithinBase(normalizedBase, resolved))) {
      return new Response(null, { status: 403 });
    }
    let canonical: string;
    try {
      canonical = await realpath(resolved);
    } catch {
      return new Response(null, { status: 404 });
    }
    if (!isFileUnderBase(normalizedBase, canonical)) {
      return new Response(null, { status: 403 });
    }
    try {
      const bytes = await readFile(canonical);
      const ext = path.extname(canonical).toLowerCase();
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
