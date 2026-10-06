import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Markdown } from "./Message";

const plotly = vi.hoisted(() => ({
  react: vi.fn((...args: unknown[]) => Promise.resolve(args)),
  purge: vi.fn(),
  Plots: { resize: vi.fn() },
}));
vi.mock("plotly.js-dist-min", () => ({ default: plotly }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const chart = '{"data":[{"type":"scatter","x":[0,1],"y":[0,1]}],"layout":{"title":{"text":"Line"}}}';

describe("plotly markdown", () => {
  it("draws a valid plotly block", async () => {
    render(<Markdown text={`Before\n\n\`\`\`plotly\n${chart}\n\`\`\`\n`} />);
    const drawn = document.querySelector('[data-chart="plotly"]');
    expect(drawn).toBeTruthy();
    expect(drawn?.getAttribute("role")).toBe("img");
    expect(document.querySelector("pre")).toBeNull();
    await waitFor(() => expect(plotly.react).toHaveBeenCalledOnce());
    expect(plotly.react.mock.calls[0]?.[1]).toEqual([{ type: "scatter", x: [0, 1], y: [0, 1] }]);
  });

  it("shows the raw code when the JSON is invalid", () => {
    render(<Markdown text={"```plotly\nnot json\n```"} />);
    expect(screen.getByText("Could not draw this chart.")).toBeTruthy();
    expect(document.querySelector("pre")?.textContent).toContain("not json");
    expect(plotly.react).not.toHaveBeenCalled();
  });

  it("shows a placeholder while streaming", () => {
    render(<Markdown text={`\`\`\`plotly\n${chart}\n\`\`\``} streaming />);
    expect(screen.getByText("Drawing chart…")).toBeTruthy();
    expect(plotly.react).not.toHaveBeenCalled();
  });

  it("leaves python blocks as code", () => {
    render(<Markdown text={"```python\nprint(1)\n```"} />);
    expect(document.querySelector("pre")).toBeTruthy();
    expect(document.querySelector('[data-chart="plotly"]')).toBeNull();
  });
});
