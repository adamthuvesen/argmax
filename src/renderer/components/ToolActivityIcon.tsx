import {
  BookOpen, Bot, Brain, Camera, CircleStop, FolderSearch, GitBranch, Globe, Hourglass, Image, ListChecks,
  MessageSquare, Monitor, Pencil, Search, Sparkles, Terminal, Wrench
} from "lucide-react";
import type { JSX } from "react";
import type { ToolActivityKind } from "../lib/toolActivity.js";

const ICONS = {
  read: BookOpen, edit: Pencil, image: Image, search: Search, list: FolderSearch,
  "web-search": Globe, "web-fetch": Globe, discovery: Wrench, command: Terminal,
  tool: Wrench, agent: Bot, skill: Sparkles, "image-capture": Camera, "image-generate": Sparkles, computer: Monitor,
  "agent-message": MessageSquare, "agent-wait": Hourglass, "agent-stop": CircleStop,
  "memory-recall": Brain, "memory-save": Brain, git: GitBranch, browser: Globe, plan: ListChecks
};

export function ToolActivityIcon({ kind }: { kind: ToolActivityKind }): JSX.Element {
  const Icon = ICONS[kind];
  return <Icon size={14} className="tool-activity-icon" data-activity={kind} aria-hidden="true" />;
}
