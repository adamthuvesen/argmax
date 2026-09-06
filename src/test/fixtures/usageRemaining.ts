import { demoUsageRemaining } from "../../renderer/demoUsage.js";
import type { UsageRemaining } from "../../shared/types.js";

/** The five remaining rows the demo page shows, so tests and the demo cannot drift. */
export function usageRemainingFixture(overrides: Partial<UsageRemaining> = {}): UsageRemaining {
  return { ...demoUsageRemaining(), ...overrides };
}
