import { afterEach, describe, expect, it, vi } from "vitest";
import { editFormula, parseSpokenMath } from "./api";

function respond(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status }))));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseSpokenMath", () => {
  it("returns the server's parts", async () => {
    const parts = [
      { type: "text", text: "so " },
      { type: "formula", latex: "x^2", spoken: "x squared" },
    ];
    respond(200, { parts });
    expect(await parseSpokenMath("so x squared")).toEqual(parts);
  });

  it("keeps the plain transcript on any failure or bad shape", async () => {
    const plain = [{ type: "text", text: "x plus 1" }];
    respond(500, { detail: "boom" });
    expect(await parseSpokenMath("x plus 1")).toEqual(plain);
    respond(200, { parts: [{ type: "formula", latex: "x" }] });
    expect(await parseSpokenMath("x plus 1")).toEqual(plain);
    respond(200, { parts: [] });
    expect(await parseSpokenMath("x plus 1")).toEqual(plain);
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await parseSpokenMath("x plus 1")).toEqual(plain);
  });
});

describe("editFormula", () => {
  it("returns the new LaTeX", async () => {
    respond(200, { latex: "y" });
    expect(await editFormula("x", "make it y")).toBe("y");
  });

  it("shows the server detail, or a generic message for network errors", async () => {
    respond(503, { detail: "Set ANTHROPIC_API_KEY to edit formulas by voice" });
    await expect(editFormula("x", "y")).rejects.toThrow("Set ANTHROPIC_API_KEY to edit formulas by voice");
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    await expect(editFormula("x", "y")).rejects.toThrow("Could not update that formula");
    respond(200, { latex: "  " });
    await expect(editFormula("x", "y")).rejects.toThrow("Could not update that formula");
  });
});
