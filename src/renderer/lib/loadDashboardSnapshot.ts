import type { DashboardSnapshot } from "../../shared/types.js";

export async function loadDashboardSnapshot(): Promise<DashboardSnapshot> {
  if (!window.argmax) {
    // Vite tree-shakes the dynamic import out of the packaged renderer bundle
    // — only browser-preview loads pull in the demo fixture.
    const { demoSnapshot } = await import("../demoSnapshot.js");
    return demoSnapshot;
  }

  const [dashboard, approvals] = await Promise.all([
    window.argmax.dashboard.list(),
    window.argmax.approvals.pending()
  ]);
  return { ...dashboard, events: [], rawOutputs: [], approvals };
}
