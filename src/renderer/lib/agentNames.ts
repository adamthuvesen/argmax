import { getToolTypeBucket, type ToolCall } from "./toolCalls.js";
import { stableHash32 } from "./stableHash.js";

/**
 * Deterministic codenames for spawned subagents: 100 physicists,
 * mathematicians and computer scientists, one surname each. Names are assigned
 * by hashing each spawn's toolUseId and linear-probing past names already taken
 * in the same parent session, so a session can name up to 100 distinct agents
 * before any reuse.
 *
 * The list is ordered by recognisability. The first `HEADLINE_COUNT` entries
 * are the household names, and a session's first spawn always draws from them
 * so the codename people see most often is one they know.
 */
export const SCIENTIST_NAMES: readonly string[] = [
  "Turing", "Einstein", "Curie", "Newton", "Noether", "Lovelace", "Feynman", "Euler",
  "Gauss", "Hopper",
  "Shannon", "Dirac", "Bohr", "Maxwell", "Faraday", "Planck", "Ramanujan", "Hilbert",
  "Dijkstra", "Knuth", "Galileo", "Kepler", "Fermi", "Heisenberg", "Schrödinger", "Riemann",
  "Cantor", "Meitner", "Hamming", "Neumann",
  "Babbage", "Boole", "Gödel", "Church", "Kleene", "Lamport", "Liskov", "Hamilton",
  "Erdős", "Galois", "Abel", "Fourier", "Laplace", "Lagrange", "Bayes", "Fermat",
  "Pascal", "Leibniz", "Poincaré", "Kolmogorov", "Markov", "Pauli", "Rutherford", "Tesla",
  "Hertz", "Kelvin", "Joule", "Hubble", "Franklin", "Hypatia",
  "Archimedes", "Euclid", "Pythagoras", "Fibonacci", "Khwarizmi", "Descartes", "Bernoulli", "Cauchy",
  "Banach", "Conway", "Germain", "Kovalevskaya", "Mirzakhani", "Mandelbrot", "Boltzmann", "Lorentz",
  "Hawking", "Copernicus", "Ampère", "Ohm", "Ångström", "Bose", "Chandrasekhar", "Wu",
  "Rubin", "Landau", "Higgs", "McCarthy", "Backus", "Ritchie", "Thompson", "Zuse",
  "Wirth", "Hoare", "Karp", "Engelbart", "Cerf", "Rivest", "Codd", "Huffman"
];

/** How many leading entries of `SCIENTIST_NAMES` a session's first spawn draws from. */
export const HEADLINE_COUNT = 10;

/**
 * The name a spawn falls back to before the session's events have loaded and a
 * full assignment map exists. May collide across agents — the map is the source
 * of truth for uniqueness.
 */
export function fallbackCodename(toolUseId: string): string {
  return SCIENTIST_NAMES[stableHash32(toolUseId) % SCIENTIST_NAMES.length];
}

/**
 * Assign a distinct scientist name to every agent spawn in `tools`, keyed by
 * toolUseId. `tools` must be in timeline order (which `buildSessionToolCalls`
 * already guarantees), so an earlier agent's name never shifts when a later one
 * spawns — the probe only ever steps over names already claimed by earlier ids.
 * The first spawn probes from a headline slot, every later one from anywhere in
 * the list. Once all 100 names are taken, later spawns reuse
 * `SCIENTIST_NAMES[hash % 100]`.
 *
 * Takes the already-built tool list rather than raw events: every caller has one
 * to hand, and rebuilding it here repeated the whole tool-call reconstruction
 * once more per render.
 */
export function assignAgentCodenames(tools: readonly ToolCall[]): Map<string, string> {
  const assignments = new Map<string, string>();
  const taken = new Set<string>();
  const agentToolUseIds = tools
    .filter((tool) => getToolTypeBucket(tool.name) === "agent")
    .map((tool) => tool.toolUseId);

  for (const toolUseId of agentToolUseIds) {
    if (assignments.has(toolUseId)) continue;
    const hash = stableHash32(toolUseId);
    if (taken.size >= SCIENTIST_NAMES.length) {
      assignments.set(toolUseId, SCIENTIST_NAMES[hash % SCIENTIST_NAMES.length]);
      continue;
    }
    const start = hash % (taken.size === 0 ? HEADLINE_COUNT : SCIENTIST_NAMES.length);
    for (let step = 0; step < SCIENTIST_NAMES.length; step++) {
      const name = SCIENTIST_NAMES[(start + step) % SCIENTIST_NAMES.length];
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
