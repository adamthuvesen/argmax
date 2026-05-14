import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function rendererFileNavigationPrefix(rendererIndexPath: string): string {
  const rendererDirectory = resolve(dirname(rendererIndexPath));
  const prefix = pathToFileURL(`${rendererDirectory}/`).href;
  return prefix;
}

export function isAllowedAppNavigation(url: string, loadedOrigin: string): boolean {
  if (loadedOrigin.startsWith("file://")) {
    return url === loadedOrigin || url.startsWith(loadedOrigin);
  }
  return url.startsWith(loadedOrigin);
}
