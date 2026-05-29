/** Custom URL scheme that serves image bytes from files on disk for in-app
 *  previews (e.g. images referenced from a rendered README.md). Lives in
 *  shared/ so renderer and the Tauri protocol handler agree on the scheme. The
 *  handler restricts serving to absolute paths inside known
 *  project / workspace roots, and to whitelisted image extensions. */
export const WORKSPACE_ASSET_PROTOCOL_SCHEME = "argmax-asset";

/** Renderer-side URL builder for an absolute file path. Encodes each path
 *  segment so spaces survive the URL trip intact and the main-side handler
 *  can decode them back cleanly. Mirrors the attachment scheme's shape. */
export function workspaceAssetUrl(absoluteFilePath: string): string {
  const segments = absoluteFilePath.split("/").map((s) => encodeURIComponent(s));
  return `${WORKSPACE_ASSET_PROTOCOL_SCHEME}://file${segments.join("/")}`;
}
