import {
  BookOpen, Bot, Brain, Camera, CircleStop, FolderSearch, GitBranch, Globe, Hourglass, Image, ListChecks,
  MessageSquare, Monitor, Search, Sparkles, SquarePen, Terminal, Wrench
} from "lucide-react";
import type { JSX } from "react";
import type { ToolActivityKind } from "../lib/toolActivity.js";

const ICONS = {
  read: BookOpen, edit: SquarePen, image: Image, search: Search, list: FolderSearch,
  "web-search": Globe, "web-fetch": Globe, discovery: Wrench, command: Terminal,
  tool: Wrench, agent: Bot, skill: Sparkles, "image-capture": Camera, "image-generate": Sparkles, computer: Monitor,
  "agent-message": MessageSquare, "agent-wait": Hourglass, "agent-stop": CircleStop,
  "memory-recall": Brain, "memory-save": Brain, git: GitBranch, browser: Globe, plan: ListChecks
};

export function ToolActivityIcon({
  kind,
  danger = false
}: {
  kind: ToolActivityKind;
  danger?: boolean;
}): JSX.Element {
  const Icon = ICONS[kind];
  return (
    <Icon
      size={14}
      className="tool-activity-icon"
      data-activity={kind}
      data-tone={danger ? "danger" : undefined}
      aria-hidden="true"
    />
  );
}
