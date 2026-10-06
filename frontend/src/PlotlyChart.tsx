import { useEffect, useMemo, useRef, useState } from "react";
import {
  CHART_LANGUAGE,
  chartHeight,
  chartLabel,
  parseChartSpec,
  readChartColors,
  themedLayout,
} from "./chart";

type PlotlyApi = typeof import("plotly.js-dist-min").default;

function useDarkClass(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setDark(root.classList.contains("dark"));
    });
    observer.observe(root, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return dark;
}

export function ChartPlaceholder() {
  return (
    <div className="my-3 flex h-24 select-none items-center justify-center rounded-lg border border-dashed border-line text-xs text-muted">
      Drawing chart…
    </div>
  );
}

export function PlotlyChart({ source }: { source: string }) {
  const spec = useMemo(() => parseChartSpec(source), [source]);
  const dark = useDarkClass();
  const [failed, setFailed] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!spec || !ref.current) return;
    const node = ref.current;
    let cancelled = false;
    let plotly: PlotlyApi | null = null;
    let frame = 0;
    let observer: ResizeObserver | undefined;
    setFailed(false);

    import("plotly.js-dist-min")
      .then(async (mod) => {
        if (cancelled) return;
        plotly = mod.default;
        await plotly.react(node, spec.data, themedLayout(spec, readChartColors()), {
          responsive: true,
          displaylogo: false,
        });
        if (cancelled) {
          plotly.purge(node);
          return;
        }
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => {
            cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
              plotly?.Plots.resize(node);
            });
          });
          observer.observe(node);
        }
      })
      .catch(() => {
        if (!cancelled) {
          plotly?.purge(node);
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      cancelAnimationFrame(frame);
      plotly?.purge(node);
    };
  }, [spec, dark]);

  if (!spec || failed) {
    return (
      <div className="my-3">
        <p className="select-none text-xs text-muted">Could not draw this chart.</p>
        <pre>
          <code>{source}</code>
        </pre>
      </div>
    );
  }

  return (
    <div
      data-chart={CHART_LANGUAGE}
      role="img"
      aria-label={chartLabel(spec)}
      className="my-3 w-full select-none overflow-hidden rounded-lg border border-line bg-panel"
      style={{ height: chartHeight(spec) }}
    >
      <div ref={ref} className="h-full w-full" />
    </div>
  );
}
