import {
  Anchor,
  Beaker,
  Bell,
  Bird,
  Bolt,
  Book,
  BookOpen,
  Bookmark,
  Bot,
  Box,
  Brain,
  Briefcase,
  Bug,
  Calendar,
  Camera,
  Cat,
  Check,
  ClipboardList,
  Cloud,
  Coffee,
  Compass,
  Cpu,
  Crown,
  Database,
  Dog,
  Feather,
  FileCode,
  FileText,
  Filter,
  Fish,
  Flag,
  Flame,
  FlaskConical,
  Folder,
  Gauge,
  Gem,
  Ghost,
  Gift,
  GitBranch,
  Globe,
  Hammer,
  Heart,
  Hourglass,
  Inbox,
  Key,
  Layers,
  Leaf,
  Lightbulb,
  Link,
  Lock,
  Map,
  MessageSquare,
  Milestone,
  Moon,
  Mountain,
  Music,
  Package,
  Palette,
  Paperclip,
  PenTool,
  Puzzle,
  Rocket,
  Ruler,
  Scissors,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Tag,
  Target,
  Telescope,
  Terminal,
  Timer,
  TrendingUp,
  Trophy,
  Users,
  Wand,
  Waves,
  Wrench,
  Zap,
  type LucideIcon
} from "lucide-react";

/**
 * Curated Lucide subset offered by the session row's Edit Icon picker. Kept as
 * an explicit map (not a dynamic import of the whole pack) so the bundle only
 * carries what the picker can actually show. Names are the wire values stored
 * in `workspaces.icon`, so removing one silently drops a user's pick: prefer
 * adding over renaming.
 */
export const SESSION_ICONS: Record<string, LucideIcon> = {
  Anchor,
  Beaker,
  Bell,
  Bird,
  Bolt,
  Book,
  BookOpen,
  Bookmark,
  Bot,
  Box,
  Brain,
  Briefcase,
  Bug,
  Calendar,
  Camera,
  Cat,
  Check,
  ClipboardList,
  Cloud,
  Coffee,
  Compass,
  Cpu,
  Crown,
  Database,
  Dog,
  Feather,
  FileCode,
  FileText,
  Filter,
  Fish,
  Flag,
  Flame,
  FlaskConical,
  Folder,
  Gauge,
  Gem,
  Ghost,
  Gift,
  GitBranch,
  Globe,
  Hammer,
  Heart,
  Hourglass,
  Inbox,
  Key,
  Layers,
  Leaf,
  Lightbulb,
  Link,
  Lock,
  Map,
  MessageSquare,
  Milestone,
  Moon,
  Mountain,
  Music,
  Package,
  Palette,
  Paperclip,
  PenTool,
  Puzzle,
  Rocket,
  Ruler,
  Scissors,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Tag,
  Target,
  Telescope,
  Terminal,
  Timer,
  TrendingUp,
  Trophy,
  Users,
  Wand,
  Waves,
  Wrench,
  Zap
};

export const SESSION_ICON_NAMES: readonly string[] = Object.keys(SESSION_ICONS);

/**
 * Palette offered next to the icon grid. Values are the wire strings stored in
 * `workspaces.icon_color`; each one has a `--session-icon-<name>` token defined
 * for every theme.
 */
export const SESSION_ICON_COLORS: readonly string[] = [
  "green",
  "teal",
  "blue",
  "violet",
  "plum",
  "clay",
  "amber",
  "pink"
];

export const DEFAULT_SESSION_ICON_COLOR = "blue";

/** "GitBranch" reads as "Git Branch" in the grid's accessible name and search. */
export function sessionIconLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/** Human name for a palette entry: "violet" reads as "Violet". */
export function sessionIconColorLabel(color: string): string {
  return color.charAt(0).toUpperCase() + color.slice(1);
}

/** Returns null for an unknown or absent name, so a stale pick degrades to the status marker. */
export function resolveSessionIcon(name: string | null | undefined): LucideIcon | null {
  if (!name) return null;
  return SESSION_ICONS[name] ?? null;
}

export function resolveSessionIconColor(color: string | null | undefined): string {
  return color && SESSION_ICON_COLORS.includes(color) ? color : DEFAULT_SESSION_ICON_COLOR;
}
