import { workspaceAssetUrl } from "../../shared/assetProtocol.js";

/**
 * Resolve a markdown `<img src>` for the rendered preview. Absolute URLs
 * (http(s):, data:, blob:, mailto:, our own scheme) pass through unchanged.
 * Relative paths are joined against the directory holding the markdown
 * file and routed through `argmax-asset://`, which the main process
 * serves only when the resolved path lives inside a known project /
 * workspace root.
 */
export function resolveMarkdownImageSrc(
  src: string | undefined,
  rootPath: string | null,
  markdownRelPath: string | null
): string | undefined {
  if (!src) return src;
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return src;
  if (!rootPath || !markdownRelPath) return src;

  const docDirSegments = markdownRelPath.split("/").slice(0, -1);
  const segments = src.startsWith("/")
    ? src.split("/").filter(Boolean)
    : [...docDirSegments, ...src.split("/")];

  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) return undefined;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }

  const absolute = `${rootPath.replace(/\/+$/, "")}/${stack.join("/")}`;
  return workspaceAssetUrl(absolute);
}
