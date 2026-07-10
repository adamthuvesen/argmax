import type { TimelineEvent } from "../../shared/types.js";
import { buildSessionToolCalls } from "./sessionConversationModel.js";
import { getToolTypeBucket, type ToolCall } from "./toolCalls.js";

/**
 * Deterministic codenames for spawned subagents. 100 moon names, assigned by
 * hashing each spawn's toolUseId and linear-probing past names already taken in
 * the same parent session, so a session can name up to 100 distinct agents
 * before any reuse.
 */
export const MOON_NAMES: readonly string[] = [
  "Phobos", "Deimos", "Io", "Europa", "Ganymede", "Callisto", "Amalthea", "Himalia",
  "Elara", "Sinope", "Carme", "Ananke", "Leda", "Thebe", "Metis", "Titan",
  "Rhea", "Iapetus", "Dione", "Tethys", "Enceladus", "Mimas", "Hyperion", "Phoebe",
  "Janus", "Epimetheus", "Pandora", "Prometheus", "Atlas", "Calypso", "Miranda", "Ariel",
  "Umbriel", "Titania", "Oberon", "Puck", "Sycorax", "Caliban", "Triton", "Nereid",
  "Naiad", "Thalassa", "Galatea", "Larissa", "Proteus", "Charon", "Styx", "Nix",
  "Kerberos", "Hydra", "Ymir", "Fenrir", "Surtur", "Skoll", "Hati", "Loge",
  "Kari", "Bestla", "Hyrrokkin", "Bergelmir", "Farbauti", "Fornjot", "Jarnsaxa", "Thrymr",
  "Skathi", "Siarnaq", "Kiviuq", "Ijiraq", "Paaliaq", "Tarqeq", "Albiorix", "Tarvos",
  "Erriapus", "Pan", "Daphnis", "Telesto", "Methone", "Pallene", "Despina", "Hippocamp",
  "Halimede", "Psamathe", "Neso", "Prospero", "Setebos", "Mab", "Cordelia", "Pasiphae",
  "Lysithea", "Callirrhoe", "Themisto", "Kalyke", "Valetudo", "Dysnomia", "Vanth", "Weywot",
  "Xiangliu", "Namaka", "Ilmarë", "Actaea"
];

/** FNV-1a 32-bit string hash. Cheap, well-distributed, and stable across runs. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * The name a spawn falls back to before the session's events have loaded and a
 * full assignment map exists. May collide across agents — the map is the source
 * of truth for uniqueness.
 */
export function fallbackCodename(toolUseId: string): string {
  return MOON_NAMES[fnv1a(toolUseId) % MOON_NAMES.length];
}

/**
 * Assign a distinct moon name to every agent spawn in `events`, keyed by
 * toolUseId. Spawns are processed in timeline order (via buildSessionToolCalls),
 * so an earlier agent's name never shifts when a later one spawns — the probe
 * only ever steps over names already claimed by earlier ids. Once all 100 names
 * are taken, later spawns reuse `MOON_NAMES[hash % 100]`.
 */
export function assignAgentCodenames(
  events: TimelineEvent[],
  sessionRunning: boolean
): Map<string, string> {
  const assignments = new Map<string, string>();
  const taken = new Set<string>();
  const agentToolUseIds = buildSessionToolCalls(events, sessionRunning)
    .filter((tool: ToolCall) => getToolTypeBucket(tool.name) === "agent")
    .map((tool) => tool.toolUseId);

  for (const toolUseId of agentToolUseIds) {
    if (assignments.has(toolUseId)) continue;
    const start = fnv1a(toolUseId) % MOON_NAMES.length;
    if (taken.size >= MOON_NAMES.length) {
      assignments.set(toolUseId, MOON_NAMES[start]);
      continue;
    }
    for (let step = 0; step < MOON_NAMES.length; step++) {
      const name = MOON_NAMES[(start + step) % MOON_NAMES.length];
      if (!taken.has(name)) {
        taken.add(name);
        assignments.set(toolUseId, name);
        break;
      }
    }
  }
  return assignments;
}

/**
 * Resolve the codename to show for a tool row: the assigned name for agent
 * spawns (falling back to the hash-only name if events aren't loaded yet), or
 * undefined for any non-agent tool.
 */
export function codenameForTool(
  tool: ToolCall,
  codenames?: Map<string, string>
): string | undefined {
  if (getToolTypeBucket(tool.name) !== "agent") return undefined;
  return codenames?.get(tool.toolUseId) ?? fallbackCodename(tool.toolUseId);
}
