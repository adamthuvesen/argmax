import type {
  Heading,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type PlanItem = {
  title: string;
  children?: PlanItem[];
};

export type PlanSection = {
  label: string;
  items: PlanItem[];
  /** Paragraph body shown beneath the section label when the section has no list. */
  note?: string;
};

export type PlanAction = {
  question: string;
  options: { label: string }[];
};

export type Plan = {
  title: string;
  summary: string[];
  sections: PlanSection[];
  action: PlanAction;
};

const DEFAULT_ACTION: PlanAction = {
  question: "Implement this plan?",
  options: [
    { label: "Yes, implement this plan" },
    { label: "No, and tell Claude what to do differently" }
  ]
};

const ACTION_LABEL = /^(action|decide|next|implement)\b/i;

export function parsePlan(markdown: string): Plan | null {
  if (typeof markdown !== "string" || markdown.trim().length === 0) return null;

  let tree: Root;
  try {
    tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  } catch {
    return null;
  }

  const nodes = tree.children;
  if (nodes.length === 0) return null;

  // 1. Title = the first heading at any depth. Anything else means it isn't a plan.
  let titleIdx = -1;
  let titleDepth = 0;
  let title = "";
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (node && node.type === "heading") {
      titleIdx = i;
      titleDepth = node.depth;
      title = stringifyInlineFromHeadingOrParagraph(markdown, node);
      break;
    }
  }
  if (titleIdx === -1 || title.length === 0) return null;

  // 2. Walk the rest, splitting at section markers. A section marker is:
  //    (a) any heading with depth > titleDepth, OR
  //    (b) a paragraph whose first phrasing child is a `strong` followed by ":"
  //        (with or without inline body content after it).
  const summary: string[] = [];
  const sections: PlanSection[] = [];
  let trailingQuestionParagraph: string | null = null;
  let optionsList: List | null = null;

  // openSection holds the "current" section being filled until the next marker.
  let openSection: PlanSection | null = null;
  let preSectionPhase = true; // before we've seen any section marker
  let inActionBlock = false;
  let explicitActionQuestion: string | null = null;
  let explicitActionList: List | null = null;

  const finalize = (): void => {
    if (openSection) {
      sections.push(openSection);
      openSection = null;
    }
  };

  for (let i = titleIdx + 1; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node) continue;

    // (a) Heading marker
    if (node.type === "heading" && node.depth > titleDepth) {
      finalize();
      preSectionPhase = false;
      const label = stringifyInlineFromHeadingOrParagraph(markdown, node);
      if (ACTION_LABEL.test(label.trim())) {
        inActionBlock = true;
        explicitActionQuestion = null;
        explicitActionList = null;
        continue;
      }
      inActionBlock = false;
      openSection = { label, items: [] };
      continue;
    }

    // (b) Bold-label paragraph marker
    if (node.type === "paragraph") {
      const labelInfo = boldLabelInfo(markdown, node);
      if (labelInfo) {
        finalize();
        preSectionPhase = false;
        if (ACTION_LABEL.test(labelInfo.label.trim())) {
          inActionBlock = true;
          // A bold-label action may carry the question inline as the note.
          if (labelInfo.note) explicitActionQuestion = labelInfo.note;
          explicitActionList = null;
          continue;
        }
        inActionBlock = false;
        openSection = { label: labelInfo.label, items: [] };
        if (labelInfo.note) openSection.note = labelInfo.note;
        continue;
      }
    }

    // Lists
    if (node.type === "list") {
      if (inActionBlock) {
        explicitActionList = node;
        continue;
      }
      if (openSection) {
        // First list inside a section fills its items.
        if (openSection.items.length === 0) {
          openSection.items = node.children
            .filter((c): c is ListItem => c.type === "listItem")
            .map((item) => parseListItem(markdown, item))
            .filter((item): item is PlanItem => item !== null);
        }
        continue;
      }
      // A list outside any section may be the option list for the trailing
      // question. We track it but only honor it later if the trailing
      // question paragraph is right before it.
      if (trailingQuestionParagraph) {
        optionsList = node;
      }
      continue;
    }

    // Paragraphs
    if (node.type === "paragraph") {
      const text = stringifyInlineFromHeadingOrParagraph(markdown, node);
      if (inActionBlock) {
        if (text.length > 0 && !explicitActionQuestion) explicitActionQuestion = text;
        continue;
      }
      // A "?"-ending paragraph anywhere outside an explicit action block is
      // a candidate for the trailing question — that takes priority over
      // attaching it as a section's note.
      if (text.endsWith("?")) {
        finalize();
        trailingQuestionParagraph = text;
        optionsList = null;
        continue;
      }
      if (preSectionPhase) {
        if (text.length > 0) summary.push(text);
        continue;
      }
      if (openSection) {
        // A paragraph inside a section becomes the note (only set the first one).
        if (!openSection.note && text.length > 0) openSection.note = text;
        continue;
      }
    }

    // Anything else (code blocks, thematic breaks) is ignored — plans live in
    // text + lists.
  }
  finalize();

  // 3. The action question. An explicit ## Action / **Action:** block beats
  //    the trailing-paragraph heuristic; otherwise fall back to a "?"-ending
  //    paragraph; otherwise synthesize defaults.
  let action: PlanAction = DEFAULT_ACTION;
  const actionQuestion = explicitActionQuestion ?? trailingQuestionParagraph;
  const actionList = explicitActionList ?? optionsList;
  if (actionQuestion) {
    const options: { label: string }[] = actionList
      ? actionList.children
          .filter((c): c is ListItem => c.type === "listItem")
          .map((item) => ({ label: stringifyListItemTitle(markdown, item) }))
          .filter((opt) => opt.label.length > 0)
      : [];
    action = {
      question: actionQuestion,
      options: options.length > 0 ? options : DEFAULT_ACTION.options
    };
  }

  // 4. Plan must surface SOME structure beyond the title — at least one section
  //    with items, or a section with a note, or a non-default action. Otherwise
  //    fall back to ChatBubble (a one-sentence reply shouldn't become a card).
  const hasStructure =
    sections.some((s) => s.items.length > 0 || s.note) ||
    Boolean(actionQuestion) ||
    summary.length > 1;
  if (!hasStructure) return null;

  return { title, summary, sections, action };
}

function boldLabelInfo(source: string, node: Paragraph): { label: string; note?: string } | null {
  const children = node.children;
  const first = children[0];
  if (!first || first.type !== "strong") return null;
  const labelRaw = inlineToText(first.children);
  const labelText = labelRaw.replace(/:\s*$/, "").trim();
  if (!labelText) return null;

  // Whatever remains after the strong (and an optional leading colon) is the
  // inline note body. We slice the raw markdown so backticks/emphasis survive.
  const bodyStartOffset = first.position?.end.offset;
  if (typeof bodyStartOffset !== "number") return null;
  let bodyText = source.slice(bodyStartOffset, getParagraphEndOffset(node) ?? bodyStartOffset);
  // Drop a leading colon + whitespace if the colon wasn't part of the strong text.
  bodyText = bodyText.replace(/^\s*:?\s*/, "");
  // Disqualify paragraphs that look like full sentences rather than labels.
  // A label is short (<= 60 chars) and contains no terminal "." that isn't a
  // file extension. This avoids treating `**Note.** ...` style sentences as
  // section markers.
  if (labelText.length > 60) return null;

  if (bodyText.trim().length > 0) {
    return { label: labelText, note: bodyText.trim() };
  }
  return { label: labelText };
}

function getParagraphEndOffset(node: Paragraph): number | null {
  const last = node.children[node.children.length - 1];
  const end = last?.position?.end.offset;
  return typeof end === "number" ? end : null;
}

function inlineToText(children: readonly PhrasingContent[]): string {
  return children
    .map((c) => {
      if (c.type === "text") return c.value;
      if (c.type === "inlineCode") return c.value;
      if (c.type === "strong" || c.type === "emphasis") return inlineToText(c.children);
      if (c.type === "link") return inlineToText(c.children);
      return "";
    })
    .join("");
}

function parseListItem(source: string, item: ListItem): PlanItem | null {
  let titleText = "";
  const children: PlanItem[] = [];

  for (const child of item.children) {
    if (child.type === "paragraph" && titleText === "") {
      titleText = stringifyInlineFromHeadingOrParagraph(source, child);
    } else if (child.type === "list") {
      for (const sub of child.children) {
        if (sub.type !== "listItem") continue;
        const subItem = parseListItem(source, sub);
        if (subItem) children.push({ title: subItem.title });
      }
    }
  }

  if (titleText.length === 0) return null;
  return children.length > 0 ? { title: titleText, children } : { title: titleText };
}

function stringifyListItemTitle(source: string, item: ListItem): string {
  const first = item.children.find((c): c is Paragraph => c.type === "paragraph");
  return first ? stringifyInlineFromHeadingOrParagraph(source, first) : "";
}

function stringifyInlineFromHeadingOrParagraph(
  source: string,
  node: Heading | Paragraph
): string {
  // Return the raw markdown of the inline content by slicing the original
  // source between the first child's start and the last child's end. This
  // preserves backticks, emphasis, links — anything the downstream
  // ReactMarkdown renderer needs to reproduce inline chips.
  const kids = node.children;
  if (kids.length === 0) return "";
  const first = kids[0];
  const last = kids[kids.length - 1];
  const startOffset = first?.position?.start.offset;
  const endOffset = last?.position?.end.offset;
  if (typeof startOffset === "number" && typeof endOffset === "number" && endOffset > startOffset) {
    return source.slice(startOffset, endOffset).trim();
  }
  return kids
    .map((child) => {
      if (child.type === "text") return child.value;
      if (child.type === "inlineCode") return `\`${child.value}\``;
      if (child.type === "emphasis") return `*${strongOrEmphasisInner(child.children)}*`;
      if (child.type === "strong") return `**${strongOrEmphasisInner(child.children)}**`;
      return "";
    })
    .join("")
    .trim();
}

function strongOrEmphasisInner(children: readonly PhrasingContent[]): string {
  return children
    .map((c) => {
      if (c.type === "text") return c.value;
      if (c.type === "inlineCode") return `\`${c.value}\``;
      return "";
    })
    .join("");
}
