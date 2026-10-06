import { describe, expect, it } from "vitest";
import { chartHeight, is3d, parseChartSpec, themedLayout, type ChartColors } from "./chart";

const colors: ChartColors = { ink: "#111111", muted: "#222222", line: "#333333" };

function spec(body: unknown) {
  return parseChartSpec(JSON.stringify(body));
}

describe("parseChartSpec", () => {
  it("returns null for invalid JSON, empty data, a bad trace, and an array layout", () => {
    expect(parseChartSpec("not json")).toBeNull();
    expect(parseChartSpec("{}")).toBeNull();
    expect(parseChartSpec('{"data":[]}')).toBeNull();
    expect(parseChartSpec('{"data":"x"}')).toBeNull();
    expect(spec({ data: ["x"] })).toBeNull();
    expect(spec({ data: [{ type: "scatter" }], layout: [] })).toBeNull();
  });

  it("accepts a valid spec", () => {
    const parsed = spec({
      data: [{ type: "scatter", x: [0, 1], y: [0, 1] }],
      layout: { title: { text: "Line" } },
    });
    expect(parsed?.data).toEqual([{ type: "scatter", x: [0, 1], y: [0, 1] }]);
    expect(parsed?.layout.title).toEqual({ text: "Line" });
  });

  it("drops layout images and width", () => {
    const parsed = spec({
      data: [{ type: "scatter", y: [1] }],
      layout: { width: 100, images: [{ source: "https://example.com/a.png" }], title: "Kept" },
    });
    expect(parsed?.layout).toEqual({ title: "Kept" });
  });
});

describe("is3d", () => {
  it("is true for a surface and false for a scatter", () => {
    const surface = spec({ data: [{ type: "surface", z: [[1]] }] });
    const scatter = spec({ data: [{ type: "scatter", y: [1] }] });
    expect(surface && is3d(surface)).toBe(true);
    expect(scatter && is3d(scatter)).toBe(false);
  });
});

describe("chartHeight", () => {
  it("uses 340 for 2D, 440 for 3D, and clamps an asked height", () => {
    const scatter = spec({ data: [{ type: "scatter", y: [1] }] })!;
    const surface = spec({ data: [{ type: "surface", z: [[1]] }] })!;
    const short = spec({ data: [{ type: "scatter", y: [1] }], layout: { height: 10 } })!;
    const tall = spec({ data: [{ type: "scatter", y: [1] }], layout: { height: 900 } })!;
    const asked = spec({ data: [{ type: "scatter", y: [1] }], layout: { height: 400 } })!;
    expect(chartHeight(scatter)).toBe(340);
    expect(chartHeight(surface)).toBe(440);
    expect(chartHeight(short)).toBe(240);
    expect(chartHeight(tall)).toBe(720);
    expect(chartHeight(asked)).toBe(400);
  });
});

describe("themedLayout", () => {
  it("does not mutate the input and themes colors", () => {
    const parsed = spec({
      data: [{ type: "scatter", y: [1] }],
      layout: { xaxis: { title: { text: "Time" } }, title: { text: "Line" } },
    })!;
    const snapshot = structuredClone(parsed);
    const layout = themedLayout(parsed, colors);
    expect(parsed).toEqual(snapshot);
    expect(layout.paper_bgcolor).toBe("rgba(0,0,0,0)");
    expect(layout.plot_bgcolor).toBe("rgba(0,0,0,0)");
    expect(layout.font).toMatchObject({ color: colors.ink });
    expect(layout.xaxis).toMatchObject({ title: { text: "Time" } });
    expect(layout.scene).toBeUndefined();
  });

  it("adds a scene only for 3D", () => {
    const surface = spec({ data: [{ type: "surface", z: [[1, 2], [3, 4]] }] })!;
    const layout = themedLayout(surface, colors);
    expect(layout.scene).toBeTruthy();
  });
});
