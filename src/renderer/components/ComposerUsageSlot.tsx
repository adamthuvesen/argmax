import { Suspense, lazy, type JSX } from "react";
import type { ProviderId } from "../../shared/types.js";
import { importChunk } from "../lib/importChunk.js";

// The plan figure is a convenience on the toolbar, not part of first paint, and
// it drags the Usage page's formatting helpers with it. It loads as its own
// chunk, so the entry stays inside its size budget (scripts/check-bundle.mjs).
const ComposerUsageChip = lazy(() =>
  importChunk(async () => ({
    default: (await import("./ComposerUsageChip.js")).ComposerUsageChip
  }))
);

export function ComposerUsageSlot({ provider }: { provider: ProviderId }): JSX.Element {
  return (
    <Suspense fallback={null}>
      <ComposerUsageChip provider={provider} />
    </Suspense>
  );
}
