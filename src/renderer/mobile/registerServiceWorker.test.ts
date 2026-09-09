import { describe, expect, it } from "vitest";
import { reasonToSkip } from "./registerServiceWorker.js";

describe("reasonToSkip", () => {
  it("installs the shell on a phone served over TLS", () => {
    expect(reasonToSkip({ supported: true, secureContext: true, dev: false })).toBeNull();
  });

  it("stays out of the way on the plain-HTTP bridge", () => {
    // Today's tailnet origin. A worker cannot register here at all, so the
    // guard is what keeps the failure quiet rather than thrown.
    expect(reasonToSkip({ supported: true, secureContext: false, dev: false })).toBe("insecure-context");
  });

  it("never fronts the dev server, which would serve yesterday's bundle", () => {
    expect(reasonToSkip({ supported: true, secureContext: true, dev: true })).toBe("dev");
  });

  it("reports an unsupported browser separately from a refused one", () => {
    expect(reasonToSkip({ supported: false, secureContext: true, dev: false })).toBe("unsupported");
  });
});
