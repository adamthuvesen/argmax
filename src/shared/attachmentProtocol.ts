/** Custom URL scheme that serves files from the attachments folder. Lives in
 *  shared/ so the renderer and Tauri protocol handler agree on the scheme. */
export const ATTACHMENT_PROTOCOL_SCHEME = "argmax-attachment";

/** Renderer-side URL builder for an absolute attachment path. Encodes each
 *  path segment so spaces in `Application Support` survive the URL trip
 *  intact and the main-side handler can decode it back cleanly. */
export function attachmentProtocolUrl(absoluteFilePath: string): string {
  const segments = absoluteFilePath.split("/").map((s) => encodeURIComponent(s));
  return `${ATTACHMENT_PROTOCOL_SCHEME}://file${segments.join("/")}`;
}
