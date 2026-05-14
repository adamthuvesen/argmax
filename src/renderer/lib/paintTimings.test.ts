import { afterEach, describe, expect, it } from "vitest";
import {
  FIRST_CONTENT_MARK,
  FIRST_PAINT_MARK,
  TTI_MEASURE,
  markFirstContent,
  markFirstPaint,
  readFirstContentMeasure,
  resetPaintTimingsForTesting
} from "./paintTimings.js";

afterEach(() => {
  resetPaintTimingsForTesting();
});

describe("paintTimings", () => {
  it("fires both marks and produces a positive measure", () => {
    markFirstPaint();
    // A tiny synchronous spin so first-content lands after first-paint by
    // at least one perf-clock tick on jsdom.
    let acc = 0;
    for (let i = 0; i < 10_000; i += 1) acc += i;
    expect(acc).toBeGreaterThan(0);
    markFirstContent();

    expect(performance.getEntriesByName(FIRST_PAINT_MARK)).toHaveLength(1);
    expect(performance.getEntriesByName(FIRST_CONTENT_MARK)).toHaveLength(1);
    expect(performance.getEntriesByName(TTI_MEASURE)).toHaveLength(1);

    const measure = readFirstContentMeasure();
    expect(measure).not.toBeNull();
    expect(measure ?? -1).toBeGreaterThanOrEqual(0);
  });

  it("is idempotent — duplicate marks do not double-record", () => {
    markFirstPaint();
    markFirstPaint();
    markFirstContent();
    markFirstContent();

    expect(performance.getEntriesByName(FIRST_PAINT_MARK)).toHaveLength(1);
    expect(performance.getEntriesByName(FIRST_CONTENT_MARK)).toHaveLength(1);
    expect(performance.getEntriesByName(TTI_MEASURE)).toHaveLength(1);
  });

  it("bails on first-content when first-paint never fired", () => {
    markFirstContent();

    expect(performance.getEntriesByName(FIRST_CONTENT_MARK)).toHaveLength(0);
    expect(performance.getEntriesByName(TTI_MEASURE)).toHaveLength(0);
    expect(readFirstContentMeasure()).toBeNull();
  });
});
