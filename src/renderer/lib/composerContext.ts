/**
 * Chat references: the context a person attaches to a prompt by naming
 * another chat.
 *
 * A reference is plain text, `[title](argmax://chat/<session id>?v=1&e=<event id>)`,
 * and that text is the only copy of it. The draft, the queued message, the
 * sent prompt, the clipboard and the transcript all hold the same string, so
 * there is no record to keep in step with it and nothing to lose when a draft
 * is restored, a queued message is taken back for editing, or a prompt is
 * recalled with ↑. The editor draws the text as a chip; a provider, the phone
 * and any plain-text surface read the link as it is.
 *
 * The id is what matters. The title is the chat's name when it was attached,
 * kept so a reference whose chat has since gone still says what it was
 * (an unresolved reference stays visible). The backend treats a link in a
 * person's prompt as that person's grant to read exactly that chat — see
 * `human_prompt_references_session` and docs/agent-tools.md.
 */

/** Same string the backend searches prompts for. */
export const CHAT_REFERENCE_PREFIX = "argmax://chat/";

/** Record shape version, written into every link and clipboard payload. */
const CHAT_REFERENCE_VERSION = 1;

/** MIME type of a copied prompt that carries its references. */
export const COMPOSER_CLIPBOARD_MIME = "application/x-argmax-composer+json";

const MAX_TITLE_CHARS = 120;

export interface ChatReference {
  v: 1;
  /** The chat's session id. Stable for the life of the chat. */
  sessionId: string;
  /** One entry of that chat, when the reference points at a line of it. */
  eventId?: string;
  /** The chat's name when it was attached. Display only. */
  title: string;
}

interface ChatReferenceMatch {
  /** Offsets of the whole `[title](link)` in the text. */
  from: number;
  to: number;
  reference: ChatReference;
}

const ID_CHARS = "[A-Za-z0-9_-]{1,64}";

/**
 * The link as written. A title may not hold brackets or newlines (see
 * `chatReferenceLink`); a link with any other version is not matched, so a
 * reference this build cannot read stays in the draft as visible text rather
 * than turning into a chip that means something else.
 */
function referencePattern(): RegExp {
  return new RegExp(
    `\\[([^\\[\\]\\n]{1,${MAX_TITLE_CHARS}})\\]\\(${CHAT_REFERENCE_PREFIX.replace(
      /[/:]/g,
      "\\$&"
    )}(${ID_CHARS})(?:\\?([A-Za-z0-9_=&.-]*))?\\)`,
    "g"
  );
}

function titleForLink(title: string): string {
  const flat = title
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s{2,}/g, " ")
    .trim();
  const clipped = [...flat].slice(0, MAX_TITLE_CHARS).join("");
  return clipped || "Chat";
}

/** The text that stands for a chat reference in a prompt. */
export function chatReferenceLink(reference: {
  sessionId: string;
  eventId?: string;
  title: string;
}): string {
  if (!new RegExp(`^${ID_CHARS}$`).test(reference.sessionId)) {
    throw new Error(`Not a chat id: ${reference.sessionId}`);
  }
  const query = [`v=${CHAT_REFERENCE_VERSION}`];
  if (reference.eventId !== undefined) {
    if (!new RegExp(`^${ID_CHARS}$`).test(reference.eventId)) {
      throw new Error(`Not an event id: ${reference.eventId}`);
    }
    query.push(`e=${reference.eventId}`);
  }
  return `[${titleForLink(reference.title)}](${CHAT_REFERENCE_PREFIX}${reference.sessionId}?${query.join("&")})`;
}

function parseQuery(query: string | undefined): { version: number; eventId?: string } | null {
  const params = new URLSearchParams(query ?? "");
  // Exactly `1` or absent, spelled the way the backend's grant parser spells
  // it (`chat_reference_ids`): `Number("01")` would read as 1 here and not there.
  const rawVersion = params.get("v");
  if (rawVersion !== null && rawVersion !== String(CHAT_REFERENCE_VERSION)) return null;
  const version = CHAT_REFERENCE_VERSION;
  const eventId = params.get("e") ?? undefined;
  if (eventId !== undefined && !new RegExp(`^${ID_CHARS}$`).test(eventId)) return null;
  return { version, ...(eventId !== undefined ? { eventId } : {}) };
}

/** Every chat reference in `text`, in order. */
export function findChatReferences(text: string): ChatReferenceMatch[] {
  if (!text.includes(CHAT_REFERENCE_PREFIX)) return [];
  const matches: ChatReferenceMatch[] = [];
  for (const match of text.matchAll(referencePattern())) {
    const parsed = parseQuery(match[3]);
    if (!parsed) continue;
    matches.push({
      from: match.index,
      to: match.index + match[0].length,
      reference: {
        v: CHAT_REFERENCE_VERSION,
        sessionId: match[2],
        ...(parsed.eventId !== undefined ? { eventId: parsed.eventId } : {}),
        title: match[1]
      }
    });
  }
  return matches;
}

/** The prompt with each chat reference replaced by its title, for one-line
 *  displays (the queue lane, a sidebar label) where a link would only be noise. */
export function chatReferencesAsTitles(text: string): string {
  let flat = "";
  let cursor = 0;
  for (const match of findChatReferences(text)) {
    flat += text.slice(cursor, match.from) + match.reference.title;
    cursor = match.to;
  }
  return flat + text.slice(cursor);
}

/** The distinct chats a prompt refers to, in order of first mention. */
export function referencedSessionIds(text: string): string[] {
  return [...new Set(findChatReferences(text).map((match) => match.reference.sessionId))];
}

/**
 * What a copy puts on the clipboard next to the plain text. The references are
 * derived from the text on the way out and checked against it on the way in,
 * so the payload can never claim a reference the text does not hold.
 */
export interface ComposerClipboardPayload {
  v: 1;
  text: string;
  references: ChatReference[];
}

export function encodeClipboardPayload(text: string): string {
  const payload: ComposerClipboardPayload = {
    v: CHAT_REFERENCE_VERSION,
    text,
    references: findChatReferences(text).map((match) => match.reference)
  };
  return JSON.stringify(payload);
}

/**
 * The prompt text out of a typed clipboard entry, or null when the entry is
 * not one of ours: malformed JSON, another version, or text that does not
 * hold the references the payload lists. The caller then falls back to the
 * plain text, which is always present.
 */
export function decodeClipboardPayload(raw: string): ComposerClipboardPayload | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const { v, text, references } = value as {
    v?: unknown;
    text?: unknown;
    references?: unknown;
  };
  if (v !== CHAT_REFERENCE_VERSION || typeof text !== "string" || !Array.isArray(references)) {
    return null;
  }
  const inText = findChatReferences(text).map((match) => match.reference);
  const listed = references as ChatReference[];
  const consistent =
    listed.length === inText.length &&
    listed.every(
      (entry, index) =>
        entry?.sessionId === inText[index]?.sessionId && entry?.eventId === inText[index]?.eventId
    );
  return consistent ? { v: CHAT_REFERENCE_VERSION, text, references: inText } : null;
}

/**
 * Where a link's chat stands. A chip for a chat that is no longer in the app
 * says so rather than offering to open nothing.
 */
export type ChatReferenceStatus = "resolved" | "unresolved";
