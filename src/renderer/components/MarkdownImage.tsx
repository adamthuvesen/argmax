import { useEffect, useState, type JSX } from "react";
import type { WorkspaceSummary } from "../../shared/types.js";
import { resolveChatImageSrc } from "../lib/chatImageSrc.js";
import { FileChip, type FileChipOpenOptions } from "./FileChip.js";
import { ImageLightbox } from "./ImageLightbox.js";
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
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setFailed(false);
    setExpanded(false);
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
  // Inline at the transcript's measure, full size on click — the same lightbox
  // a sent attachment opens, so an image the agent drew and one the user
  // attached behave alike. A button rather than a click handler on the image,
  // so the keyboard reaches it and the role says what it does.
  return (
    <>
      <button
        type="button"
        className="markdown-image-button"
        aria-label={`${label} — view larger`}
        title="View larger"
        onClick={() => setExpanded(true)}
      >
        <img className="markdown-image" src={resolved} alt={label} onError={() => setFailed(true)} />
      </button>
      <ImageLightbox src={expanded ? resolved : null} alt={label} onClose={() => setExpanded(false)} />
    </>
  );
}
