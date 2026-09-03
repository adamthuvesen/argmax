import { attachmentProtocolUrl } from "../../shared/attachmentProtocol.js";
import { workspaceAssetUrl } from "../../shared/assetProtocol.js";

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
 * Resolve an assistant Markdown image without widening filesystem access.
 * Web images keep their URL. Workspace images use the workspace asset
 * protocol. Other absolute paths use the attachment protocol, whose handler
 * serves only files already stored in Argmax's attachment directory.
 */
export function resolveChatImageSrc(
  source: string | undefined,
  workspacePath: string | null | undefined
): string | null {
  if (!source) return null;
  if (/^https?:\/\//i.test(source)) return source;
  if (/^argmax-(?:asset|attachment):\/\//i.test(source)) return source;

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

