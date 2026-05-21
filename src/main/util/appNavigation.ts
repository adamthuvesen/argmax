import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function rendererFileNavigationPrefix(rendererIndexPath: string): string {
  const rendererDirectory = resolve(dirname(rendererIndexPath));
  const prefix = pathToFileURL(`${rendererDirectory}/`).href;
  return prefix;
}

export function isAllowedAppNavigation(url: string, loadedOrigin: string): boolean {
  // Defense in depth — startsWith is too loose: `http://127.0.0.1:5173.evil.com`
  // startsWith `http://127.0.0.1:5173`, and `file:///.../renderer/../../etc/x`
  // also "startsWith" the renderer file:// prefix. Parse both via WHATWG URL,
  // compare origins strictly, and (for file:) require the pathname stays under
  // the renderer directory after normalization. (audit-2026-05-17 M20)
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (loadedOrigin.startsWith("file://")) {
    if (target.protocol !== "file:") return false;
    // file: URLs have origin "null"; compare the pathname prefix instead, but
    // first normalize away `..` segments so traversal can't escape.
    const originPath = new URL(loadedOrigin).pathname;
    const targetPath = target.pathname;
    // Decode percent-encoded segments before the traversal check — the WHATWG
    // URL parser leaves `%2e%2e` unchanged so an attacker-controlled URL like
    // `file:///app/%2e%2e/etc/passwd` would otherwise pass the `/../` check.
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(targetPath);
    } catch {
      return false;
    }
    if (decodedPath.includes("/../") || decodedPath.endsWith("/..")) return false;
    return targetPath === originPath || targetPath.startsWith(originPath);
  }
  let origin: URL;
  try {
    origin = new URL(loadedOrigin);
  } catch {
    return false;
  }
  return target.origin === origin.origin;
}
