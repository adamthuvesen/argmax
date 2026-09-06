import { formatRemoteTokenQuery, isRemoteEnvironment } from "./remoteProtocol.js";

/** Custom URL scheme that serves image bytes from files on disk for in-app
 *  previews (e.g. images referenced from a rendered README.md). Lives in
 *  shared/ so renderer and the Tauri protocol handler agree on the scheme. The
 *  handler restricts serving to absolute paths inside known
 *  project / workspace roots, and to whitelisted image extensions. */
export const WORKSPACE_ASSET_PROTOCOL_SCHEME = "argmax-asset";

/** Renderer-side URL builder for an absolute file path. Encodes each path
 *  segment so spaces survive the URL trip intact and the main-side handler
 *  can decode them back cleanly. Mirrors the attachment scheme's shape.
 *
 *  When running over the mobile remote bridge, translates to the authenticated
 *  `/api/workspace-assets/...` HTTP endpoint so images render in standard web browsers. */
export function workspaceAssetUrl(absoluteFilePath: string): string {
  const segments = absoluteFilePath.split("/").map((s) => encodeURIComponent(s));
  if (isRemoteEnvironment()) {
    return `/api/workspace-assets${segments.join("/")}${formatRemoteTokenQuery()}`;
  }
  return `${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file${segments.join("/")}`;
}

/** Translate an `argmax-asset://file/...` URL to an HTTP URL if running
 *  over the remote bridge, or leave as-is on desktop. */
export function toRenderableWorkspaceAssetUrl(urlOrPath: string): string {
  if (!isRemoteEnvironment()) return urlOrPath;
  const prefix = `${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file`;
  if (urlOrPath.startsWith(prefix)) {
    const pathPart = urlOrPath.slice(prefix.length);
    return `/api/workspace-assets${pathPart}${formatRemoteTokenQuery()}`;
  }
  return urlOrPath;
}
