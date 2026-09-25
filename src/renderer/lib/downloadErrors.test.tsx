import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendLogEntry, PerformanceCapture } from "../../shared/types.js";
import { saveLogsFile } from "./logDownload.js";
import { savePerformanceCapture } from "./performanceDownload.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("diagnostic downloads", () => {
  it("reports a failed log download without claiming it was saved", () => {
    vi.stubGlobal("URL", { createObjectURL: () => { throw new Error("Download unavailable"); } });
    const setStatus = vi.fn();
    const onError = vi.fn();
    const entry: BackendLogEntry = {
      seq: 1, timestamp: "2026-09-26T00:00:00Z", level: "info", scope: "test", message: "hello", fields: {}
    };

    saveLogsFile([entry], setStatus, onError);

    expect(onError).toHaveBeenCalledWith("Download unavailable");
    expect(setStatus).not.toHaveBeenCalled();
  });

  it("reports an empty performance capture as a failed export", () => {
    const setStatus = vi.fn();
    const onError = vi.fn();

    savePerformanceCapture({ samples: [] } as unknown as PerformanceCapture, setStatus, onError);

    expect(onError).toHaveBeenCalledWith("No performance samples to save yet.");
    expect(setStatus).not.toHaveBeenCalled();
  });
});
