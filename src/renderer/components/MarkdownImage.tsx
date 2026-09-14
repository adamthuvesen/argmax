import { useEffect, useState, type JSX } from "react";
import type { WorkspaceSummary } from "../../shared/types.js";
import { resolveChatImageSrc } from "../lib/chatImageSrc.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";
import { WebLink } from "./WebLink.js";

const REMOTE_HOST = /^https?:\/\/([^/?#]+)/i;

export function MarkdownImage({
  src,
  alt,
  workspace,
  onOpenFile
}: {
  src: string | undefined;
  alt: string | undefined;
  workspace?: WorkspaceSummary | null;
  onOpenFile?: (path: string, options?: FileChipOpenOptions) => void;
}): JSX.Element | null {
  const resolved = resolveChatImageSrc(src, workspace?.path);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [resolved]);

  if (!src) return null;
  if (!resolved || failed) {
    const remoteHost = REMOTE_HOST.exec(src)?.[1];
    return (
      <span className="markdown-image-fallback">
        {alt ? <span>{alt}: </span> : null}
        {/* A remote image is a link, never a fetch: see resolveChatImageSrc. */}
        {remoteHost ? (
          <WebLink href={src} title={src}>
            {remoteHost}
          </WebLink>
        ) : (
          <FileChip
            path={src}
            line={null}
            workspaceId={workspace?.id ?? null}
            workspaceCwd={workspace?.path ?? null}
            onOpen={onOpenFile}
          />
        )}
      </span>
    );
  }

  const label = alt?.trim() || "Attached image";
  return <img className="markdown-image" src={resolved} alt={label} onError={() => setFailed(true)} />;
}
