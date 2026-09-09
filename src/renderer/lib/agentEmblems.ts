import { stableHash32 } from "./stableHash.js";

/**
 * The emblem a subagent wears: a small radially symmetric mark in one hue,
 * shaded like a soft gem so it reads as an object rather than a line icon.
 *
 * The emblem is bound to the codename, not to the spawn. `assignAgentCodenames`
 * already hands every subagent in a session a distinct scientist, so a fixed
 * (shape, hue) per name makes a session's emblems distinct for free, keeps an
 * agent's mark from shifting when a later one spawns, and — the point — makes
 * Gauss look like Gauss across sessions and projects the way a colleague's face
 * survives a change of room.
 */
export const EMBLEM_SHAPES = [
  "trefoil",
  "hourglass",
  "orbit",
  "pinwheel",
  "cluster",
  "clover",
  "bloom",
  "wreath",
  "quad",
  "star",
  "gem",
  "shell"
] as const;

export type EmblemShape = (typeof EMBLEM_SHAPES)[number];

/** The session icon palette, so emblems, sidebar rows and the workspace card
 *  never drift apart. Pinned against `SESSION_ICON_COLORS` by the tests. */
export const EMBLEM_HUES = [
  "green",
  "teal",
  "blue",
  "violet",
  "plum",
  "clay",
  "amber",
  "pink",
  "red"
] as const;

export type EmblemHue = (typeof EMBLEM_HUES)[number];

export type Emblem = {
  shape: EmblemShape;
  hue: EmblemHue;
};

/**
 * One `d` per shape, drawn on a 16x16 grid centred at (8, 8) inside a 14-unit
 * circle, each painting 48-70% of that circle so a row of them reads as one
 * family. `evenOdd` marks the shapes that carry a hole (the orbit's ring, the
 * bloom's open centre, the gem's facets); the rest are unions of subpaths wound
 * the same way, so they merge rather than cancelling.
 */
export const EMBLEM_PATHS: Readonly<Record<EmblemShape, { d: string; evenOdd?: boolean }>> = {
  // three rounded leaves meeting at the centre
  trefoil: {
    d: "M8 8C3.54 6.89 4.03 2.11 8 1.1C11.97 2.11 12.46 6.89 8 8ZM8 8C11.2 4.69 15.08 7.5 13.98 11.45C11.11 14.38 6.73 12.42 8 8ZM8 8C9.27 12.42 4.89 14.38 2.02 11.45C0.92 7.5 4.8 4.69 8 8Z"
  },
  // two circular sectors tip to tip, overlapping into a waist
  hourglass: {
    d: "M8 8.75L2.28 4.14A6.9 6.9 0 0 1 13.72 4.14ZM8 7.25L13.72 11.86A6.9 6.9 0 0 1 2.28 11.86Z"
  },
  // a ring with three discs inside it
  orbit: {
    d: "M1.1 8A6.9 6.9 0 1 0 14.9 8A6.9 6.9 0 1 0 1.1 8ZM2.3 8A5.7 5.7 0 1 0 13.7 8A5.7 5.7 0 1 0 2.3 8ZM5.6 5.1A2.4 2.4 0 1 0 10.4 5.1A2.4 2.4 0 1 0 5.6 5.1ZM8.11 9.45A2.4 2.4 0 1 0 12.91 9.45A2.4 2.4 0 1 0 8.11 9.45ZM3.09 9.45A2.4 2.4 0 1 0 7.89 9.45A2.4 2.4 0 1 0 3.09 9.45Z",
    evenOdd: true
  },
  // four curved blades
  pinwheel: {
    d: "M8 8C6.68 5.3 6.67 2.25 8 1.1A6.9 6.9 0 0 1 13.85 4.34C11.52 4.6 9.01 6.39 8 8ZM8 8C10.7 6.68 13.75 6.67 14.9 8A6.9 6.9 0 0 1 11.66 13.85C11.4 11.52 9.61 9.01 8 8ZM8 8C9.32 10.7 9.33 13.75 8 14.9A6.9 6.9 0 0 1 2.15 11.66C4.48 11.4 6.99 9.61 8 8ZM8 8C5.3 9.32 2.25 9.33 1.1 8A6.9 6.9 0 0 1 4.34 2.15C4.6 4.48 6.39 6.99 8 8Z"
  },
  // five rhombi in a plus
  cluster: {
    d: "M8 5.15L10.85 8L8 10.85L5.15 8ZM8 1.1L11.3 3.8L8 6.5L4.7 3.8ZM14.9 8L12.2 11.3L9.5 8L12.2 4.7ZM8 14.9L4.7 12.2L8 9.5L11.3 12.2ZM1.1 8L3.8 4.7L6.5 8L3.8 11.3Z"
  },
  // four heart-shaped petals
  clover: {
    d: "M8 8C6.33 6.27 4.32 3.91 5.13 1.84C6.52 1.57 7.38 2.13 8 2.65C8.62 2.13 9.48 1.57 10.87 1.84C11.68 3.91 9.67 6.27 8 8ZM8 8C9.73 6.33 12.09 4.32 14.16 5.13C14.43 6.52 13.87 7.38 13.35 8C13.87 8.62 14.43 9.48 14.16 10.87C12.09 11.68 9.73 9.67 8 8ZM8 8C9.67 9.73 11.68 12.09 10.87 14.16C9.48 14.43 8.62 13.87 8 13.35C7.38 13.87 6.52 14.43 5.13 14.16C4.32 12.09 6.33 9.73 8 8ZM8 8C6.27 9.67 3.91 11.68 1.84 10.87C1.57 9.48 2.13 8.62 2.65 8C2.13 7.38 1.57 6.52 1.84 5.13C3.91 4.32 6.27 6.33 8 8Z"
  },
  // four pointed petals around an open centre
  bloom: {
    d: "M8 1.1C9.44 1.76 11.13 3 10.33 5.67C13 4.87 14.24 6.56 14.9 8C14.24 9.44 13 11.13 10.33 10.33C11.13 13 9.44 14.24 8 14.9C6.56 14.24 4.87 13 5.67 10.33C3 11.13 1.76 9.44 1.1 8C1.76 6.56 3 4.87 5.67 5.67C4.87 3 6.56 1.76 8 1.1ZM6.1 8A1.9 1.9 0 1 0 9.9 8A1.9 1.9 0 1 0 6.1 8Z",
    evenOdd: true
  },
  // a ring of six ovals
  wreath: {
    d: "M8 5.66A2.28 2 -90 1 0 8 1.1A2.28 2 -90 1 0 8 5.66ZM10.03 6.83A2.28 2 -30 1 0 13.98 4.55A2.28 2 -30 1 0 10.03 6.83ZM10.03 9.17A2.28 2 30 1 0 13.98 11.45A2.28 2 30 1 0 10.03 9.17ZM8 10.34A2.28 2 90 1 0 8 14.9A2.28 2 90 1 0 8 10.34ZM5.97 9.17A2.28 2 150 1 0 2.02 11.45A2.28 2 150 1 0 5.97 9.17ZM5.97 6.83A2.28 2 210 1 0 2.02 4.55A2.28 2 210 1 0 5.97 6.83Z"
  },
  // four discs touching
  quad: {
    d: "M8 5.1A2.9 2.9 0 1 0 13.8 5.1A2.9 2.9 0 1 0 8 5.1ZM8 10.9A2.9 2.9 0 1 0 13.8 10.9A2.9 2.9 0 1 0 8 10.9ZM2.2 10.9A2.9 2.9 0 1 0 8 10.9A2.9 2.9 0 1 0 2.2 10.9ZM2.2 5.1A2.9 2.9 0 1 0 8 5.1A2.9 2.9 0 1 0 2.2 5.1Z"
  },
  // an eight-point star
  star: {
    d: "M8 1.1L9.63 4.07L12.88 3.12L11.93 6.37L14.9 8L11.93 9.63L12.88 12.88L9.63 11.93L8 14.9L6.37 11.93L3.12 12.88L4.07 9.63L1.1 8L4.07 6.37L3.12 3.12L6.37 4.07Z"
  },
  // a hexagon cut by three facets
  gem: {
    d: "M8 1.1L13.98 4.55L13.98 11.45L8 14.9L2.02 11.45L2.02 4.55ZM8.6 6.5L8.85 1.9L7.15 1.9L7.41 6.5ZM9 9.27L12.86 11.79L13.71 10.31L9.6 8.23ZM6.4 8.23L2.29 10.31L3.14 11.79L7 9.27Z",
    evenOdd: true
  },
  // a pair of commas, yin-yang mass
  shell: {
    d: "M4.95 4.7A3.05 3.05 0 1 0 11.05 4.7A3.05 3.05 0 1 0 4.95 4.7ZM7.07 6.01C9.77 6.23 12.4 8.15 13.38 9.54C14.8 6.8 11.86 2.28 5.8 3.07ZM4.95 11.3A3.05 3.05 0 1 0 11.05 11.3A3.05 3.05 0 1 0 4.95 11.3ZM8.93 9.99C6.23 9.77 3.6 7.85 2.62 6.46C1.2 9.2 4.14 13.72 10.2 12.93Z"
  }
};

/**
 * Every codename's emblem. Four rules hold over this table, pinned by
 * `agentEmblems.test.ts`: all 100 pairs distinct; the ten headline names cover
 * ten shapes and nine hues, so a session's first spawns are maximally unlike
 * each other; no two consecutive names share a hue, so a codename probe that
 * lands on a neighbour still changes colour; and every shape and hue appears at
 * least seven times. Editing one row is safe — the tests re-check the rules.
 */
export const EMBLEM_BY_CODENAME: Readonly<Record<string, readonly [EmblemShape, EmblemHue]>> = {
  Turing: ["cluster", "green"],
  Einstein: ["star", "violet"],
  Curie: ["orbit", "pink"],
  Newton: ["wreath", "teal"],
  Noether: ["trefoil", "clay"],
  Lovelace: ["clover", "red"],
  Feynman: ["gem", "blue"],
  Euler: ["pinwheel", "amber"],
  Gauss: ["quad", "green"],
  Hopper: ["hourglass", "plum"],
  Shannon: ["bloom", "pink"],
  Dirac: ["shell", "teal"],
  Bohr: ["cluster", "clay"],
  Maxwell: ["star", "red"],
  Faraday: ["orbit", "violet"],
  Planck: ["wreath", "amber"],
  Ramanujan: ["trefoil", "teal"],
  Hilbert: ["clover", "plum"],
  Dijkstra: ["gem", "pink"],
  Knuth: ["pinwheel", "blue"],
  Galileo: ["quad", "clay"],
  Kepler: ["hourglass", "green"],
  Fermi: ["bloom", "violet"],
  Heisenberg: ["shell", "amber"],
  Schrödinger: ["cluster", "teal"],
  Riemann: ["star", "plum"],
  Cantor: ["orbit", "red"],
  Meitner: ["wreath", "blue"],
  Hamming: ["trefoil", "amber"],
  Neumann: ["clover", "green"],
  Babbage: ["gem", "violet"],
  Boole: ["pinwheel", "pink"],
  Gödel: ["quad", "teal"],
  Church: ["hourglass", "clay"],
  Kleene: ["bloom", "red"],
  Lamport: ["shell", "blue"],
  Liskov: ["cluster", "amber"],
  Hamilton: ["star", "green"],
  Erdős: ["orbit", "plum"],
  Galois: ["wreath", "pink"],
  Abel: ["trefoil", "blue"],
  Fourier: ["clover", "clay"],
  Laplace: ["gem", "red"],
  Lagrange: ["pinwheel", "violet"],
  Bayes: ["quad", "amber"],
  Fermat: ["hourglass", "teal"],
  Pascal: ["bloom", "plum"],
  Leibniz: ["shell", "pink"],
  Poincaré: ["cluster", "blue"],
  Kolmogorov: ["star", "clay"],
  Markov: ["orbit", "green"],
  Pauli: ["wreath", "violet"],
  Rutherford: ["trefoil", "pink"],
  Tesla: ["clover", "teal"],
  Hertz: ["gem", "plum"],
  Kelvin: ["pinwheel", "red"],
  Joule: ["quad", "blue"],
  Hubble: ["hourglass", "amber"],
  Franklin: ["bloom", "green"],
  Hypatia: ["shell", "violet"],
  Archimedes: ["cluster", "pink"],
  Euclid: ["star", "teal"],
  Pythagoras: ["orbit", "clay"],
  Fibonacci: ["wreath", "red"],
  Khwarizmi: ["trefoil", "violet"],
  Descartes: ["clover", "amber"],
  Bernoulli: ["gem", "green"],
  Cauchy: ["pinwheel", "plum"],
  Banach: ["quad", "pink"],
  Conway: ["hourglass", "blue"],
  Germain: ["bloom", "clay"],
  Kovalevskaya: ["shell", "red"],
  Mirzakhani: ["cluster", "violet"],
  Mandelbrot: ["star", "amber"],
  Boltzmann: ["orbit", "teal"],
  Lorentz: ["wreath", "plum"],
  Hawking: ["trefoil", "red"],
  Copernicus: ["clover", "blue"],
  Ampère: ["gem", "clay"],
  Ohm: ["pinwheel", "green"],
  Ångström: ["quad", "violet"],
  Bose: ["hourglass", "pink"],
  Chandrasekhar: ["bloom", "teal"],
  Wu: ["shell", "plum"],
  Rubin: ["cluster", "red"],
  Landau: ["star", "blue"],
  Higgs: ["orbit", "amber"],
  McCarthy: ["wreath", "green"],
  Backus: ["trefoil", "plum"],
  Ritchie: ["clover", "pink"],
  Thompson: ["gem", "teal"],
  Zuse: ["pinwheel", "clay"],
  Wirth: ["quad", "red"],
  Hoare: ["hourglass", "violet"],
  Karp: ["bloom", "amber"],
  Engelbart: ["shell", "green"],
  Cerf: ["cluster", "plum"],
  Rivest: ["star", "pink"],
  Codd: ["orbit", "blue"],
  Huffman: ["wreath", "clay"]
};

/**
 * The emblem for a codename. Names outside the table (a label the caller
 * invented rather than a scientist) still get a stable mark from the name's own
 * hash: a subagent must never be the one row in a list with an empty box.
 */
export function emblemForCodename(codename: string): Emblem {
  const assigned = EMBLEM_BY_CODENAME[codename];
  if (assigned) return { shape: assigned[0], hue: assigned[1] };
  return emblemForKey(codename);
}

/**
 * A mark for anything that has a stable id but no codename — a multitask,
 * which is a whole chat running alongside rather than an agent with a name.
 * Shape and hue come off different digits of the same hash, so two ids that
 * collide on one still differ on the other.
 */
export function emblemForKey(key: string): Emblem {
  const hash = stableHash32(key);
  return {
    shape: EMBLEM_SHAPES[hash % EMBLEM_SHAPES.length],
    hue: EMBLEM_HUES[Math.floor(hash / EMBLEM_SHAPES.length) % EMBLEM_HUES.length]
  };
}
