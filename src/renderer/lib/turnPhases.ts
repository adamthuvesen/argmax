import type { TurnBodyChild } from "../components/TurnBlock.js";

export type TurnPhaseKind = "plan" | "work" | "result";

export interface TurnPhase {
  kind: TurnPhaseKind;
  children: TurnBodyChild[];
}

/**
 * Split a turn's flat body into up to three phases: text before tools (Plan),
 * tools plus interleaved text (Work), and text after the last tool (Result).
 * A turn with no tools collapses to a single Result phase. A turn with no
 * leading text starts directly at Work; trailing text after tools opens Result.
 *
 * The phases are a rendering construct only — the underlying TurnBodyChild
 * sequence is preserved in order, and concatenating all returned phases'
 * children yields the original input.
 */
export function splitTurnIntoPhases(body: TurnBodyChild[]): TurnPhase[] {
  if (body.length === 0) return [];

  let firstToolIndex = -1;
  let lastToolIndex = -1;
  for (let i = 0; i < body.length; i++) {
    const child = body[i];
    if (child && child.kind === "tool") {
      if (firstToolIndex === -1) firstToolIndex = i;
      lastToolIndex = i;
    }
  }

  if (firstToolIndex === -1) {
    return [{ kind: "result", children: body }];
  }

  const phases: TurnPhase[] = [];
  if (firstToolIndex > 0) {
    phases.push({ kind: "plan", children: body.slice(0, firstToolIndex) });
  }
  phases.push({ kind: "work", children: body.slice(firstToolIndex, lastToolIndex + 1) });
  if (lastToolIndex < body.length - 1) {
    phases.push({ kind: "result", children: body.slice(lastToolIndex + 1) });
  }
  return phases;
}

const PHASE_LABEL: Record<TurnPhaseKind, string> = {
  plan: "Plan",
  work: "Work",
  result: "Result"
};

export function labelForPhase(kind: TurnPhaseKind): string {
  return PHASE_LABEL[kind];
}
