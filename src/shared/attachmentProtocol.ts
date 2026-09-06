import { formatRemoteTokenQuery, isRemoteEnvironment } from "./remoteProtocol.js";

/** Custom URL scheme that serves files from the attachments folder. Lives in
 *  shared/ so the renderer and Tauri protocol handler agree on the scheme. */
export const ATTACHMENT_PROTOCOL_SCHEME = "argmax-attachment";

/** Renderer-side URL builder for an absolute attachment path. Encodes each
 *  path segment so spaces in `Application Support` survive the URL trip
 *  intact and the main-side handler can decode it back cleanly.
 *
 *  When running over the mobile remote bridge, translates to the authenticated
 *  `/api/attachments/...` HTTP endpoint so images render in standard web browsers. */
export function attachmentProtocolUrl(absoluteFilePath: string): string {
  const segments = absoluteFilePath.split("/").map((s) => encodeURIComponent(s));
  if (isRemoteEnvironment()) {
    return `/api/attachments${segments.join("/")}${formatRemoteTokenQuery()}`;
  }
  return `${ATTACHMENT_PROTOCOL_SCHEME}://file${segments.join("/")}`;
}

/** Translate an `argmax-attachment://file/...` URL to an HTTP URL if running
 *  over the remote bridge, or leave as-is on desktop. */
export function toRenderableAttachmentUrl(urlOrPath: string): string {
  if (!isRemoteEnvironment()) return urlOrPath;
  const prefix = `${ATTACHMENT_PROTOCOL_SCHEME}://file`;
  if (urlOrPath.startsWith(prefix)) {
    const pathPart = urlOrPath.slice(prefix.length);
    return `/api/attachments${pathPart}${formatRemoteTokenQuery()}`;
  }
  return urlOrPath;
}
