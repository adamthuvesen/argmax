import { describe, expect, it } from "vitest";
import { parseVisualizationReference } from "./visualizationReference.js";

describe("parseVisualizationReference", () => {
  it("accepts absolute HTML references with a title and wide mode", () => {
    expect(parseVisualizationReference('{"path":"/tmp/chart.html","mode":"wide","title":"Trends"}'))
      .toEqual({ path: "/tmp/chart.html", mode: "wide", title: "Trends" });
  });

  it.each([
    '{}', 'null', '[]', '{"path":"chart.html"}', '{"path":"https://example.com/chart.html"}',
    '{"path":"/tmp/secrets.txt"}', '{"path":"/tmp/chart.html","mode":"full"}',
    '{"path":"/tmp/chart.html","title":17}', '{"path":"/tmp/chart.html","script":"run"}'
  ])("rejects malformed or unsupported references: %s", (source) => {
    expect(() => parseVisualizationReference(source)).toThrow();
  });
});
