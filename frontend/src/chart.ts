export const CHART_LANGUAGE = "plotly";
const MAX_SOURCE_CHARS = 500_000;
const MAX_TRACES = 50;
const THREE_D_TYPES = new Set([
  "scatter3d",
  "surface",
  "mesh3d",
  "cone",
  "streamtube",
  "volume",
  "isosurface",
]);

type Layout = Record<string, unknown>;
export type ChartSpec = { data: Record<string, unknown>[]; layout: Layout };
export type ChartColors = { ink: string; muted: string; line: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseChartSpec(source: string): ChartSpec | null {
  if (source.length > MAX_SOURCE_CHARS) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;
  const data = parsed.data;
  if (!Array.isArray(data) || data.length === 0 || data.length > MAX_TRACES) return null;
  if (!data.every(isObject)) return null;
  if ("layout" in parsed && !isObject(parsed.layout)) return null;
  const rawLayout = isObject(parsed.layout) ? parsed.layout : {};
  const layout: Layout = { ...rawLayout };
  delete layout.images;
  delete layout.width;
  return { data, layout };
}

export function is3d(spec: ChartSpec): boolean {
  return spec.data.some((trace) => THREE_D_TYPES.has(String(trace.type ?? "")));
}

export function chartHeight(spec: ChartSpec): number {
  const asked = spec.layout.height;
  if (typeof asked === "number" && Number.isFinite(asked)) {
    return Math.min(720, Math.max(240, asked));
  }
  return is3d(spec) ? 440 : 340;
}

function themedAxis(axis: unknown, colors: ChartColors): Layout {
  return {
    gridcolor: colors.line,
    zerolinecolor: colors.line,
    linecolor: colors.line,
    ...(isObject(axis) ? axis : {}),
  };
}

export function themedLayout(spec: ChartSpec, colors: ChartColors): Layout {
  const layout = spec.layout;
  const scene = isObject(layout.scene) ? layout.scene : {};
  const result: Layout = {
    ...layout,
    height: chartHeight(spec),
    autosize: true,
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: {
      family: '"Source Sans 3", ui-sans-serif, system-ui, sans-serif',
      ...(isObject(layout.font) ? layout.font : {}),
      color: colors.ink,
    },
    margin: {
      l: 48,
      r: 16,
      t: layout.title ? 48 : 16,
      b: 40,
      ...(isObject(layout.margin) ? layout.margin : {}),
    },
    xaxis: themedAxis(layout.xaxis, colors),
    yaxis: themedAxis(layout.yaxis, colors),
  };
  if (is3d(spec)) {
    result.scene = {
      ...scene,
      xaxis: themedAxis(scene.xaxis, colors),
      yaxis: themedAxis(scene.yaxis, colors),
      zaxis: themedAxis(scene.zaxis, colors),
    };
  }
  return result;
}

export function chartLabel(spec: ChartSpec): string {
  const title = spec.layout.title;
  if (typeof title === "string") return title;
  if (isObject(title) && typeof title.text === "string") return title.text;
  return "Chart";
}

export function readChartColors(): ChartColors {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return { ink: read("--ink", "#1c1b19"), muted: read("--muted", "#6f6b63"), line: read("--line", "#e2dfd6") };
}
