import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { protocol, type Protocol } from "electron";
import { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";

export { WORKSPACE_ASSET_PROTOCOL_SCHEME } from "../../shared/assetProtocol.js";

/** Must be called before `app.whenReady()`. Anything after that is ignored. */
export function registerWorkspaceAssetSchemeAsPrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: WORKSPACE_ASSET_PROTOCOL_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ]);
}

function isContainedInRoot(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** True when `targetPath` is under one of `roots` (roots are already realpathed). */
async function isWithinAllowedRoots(roots: readonly string[], targetPath: string): Promise<boolean> {
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
          return roots.some((root) => isContainedInRoot(root, path.resolve(targetPath)));
        }
        dir = parent;
      }
    }
  }
  return roots.some((root) => isContainedInRoot(root, candidate));
}

const EXTENSION_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif"
};

export interface WorkspaceAssetProtocolOptions {
  /** Returns the absolute paths the handler is allowed to serve from. Each
   *  call is fresh because the set of workspaces / projects changes at
   *  runtime (the user adds/removes workspaces). */
  getAllowedRoots: () => readonly string[];
}

/** Registers the URL handler. Must be called after `app.whenReady()`. The
 *  resolved file path must live inside one of the roots returned by
 *  `getAllowedRoots()` — anything else returns 403. Only the image
 *  extensions in `EXTENSION_TO_MIME` are served; everything else is 415. */
export function registerWorkspaceAssetProtocolHandler(
  options: WorkspaceAssetProtocolOptions,
  protocolModule: Pick<Protocol, "handle"> = protocol
): void {
  protocolModule.handle(WORKSPACE_ASSET_PROTOCOL_SCHEME, async (request) => {
    let resolved: string;
    try {
      const url = new URL(request.url);
      const decoded = decodeURIComponent(url.pathname);
      resolved = path.resolve(decoded);
    } catch {
      return new Response(null, { status: 400 });
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = EXTENSION_TO_MIME[ext];
    if (!contentType) {
      return new Response(null, { status: 415 });
    }

    let roots: string[];
    try {
      roots = await Promise.all(
        options.getAllowedRoots().map(async (r) => realpath(path.resolve(r)))
      );
    } catch {
      return new Response(null, { status: 403 });
    }
    if (!(await isWithinAllowedRoots(roots, resolved))) {
      return new Response(null, { status: 403 });
    }

    try {
      // Canonicalize before serving so a symlink inside the root can't point
      // at a file outside it (would otherwise be served with our cache+mime).
      const canonical = await realpath(resolved);
      if (!(await isWithinAllowedRoots(roots, canonical))) {
        return new Response(null, { status: 403 });
      }
      const info = await stat(canonical);
      if (!info.isFile()) return new Response(null, { status: 404 });
      const bytes = await readFile(canonical);
      const body = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return new Response(body, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "private, max-age=60"
        }
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
}
