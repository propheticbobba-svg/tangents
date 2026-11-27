// Tests for scripts/run-tests.mjs, using fake server/screen commands so the real suites don't recurse.
import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(process.cwd(), "..");
const runner = path.join(root, "scripts", "run-tests.mjs");
const node = process.execPath;
const fake = (lines: string[], code = 0) =>
  JSON.stringify([node, "-e", `console.log(${JSON.stringify(lines.join("\n"))});process.exit(${code})`]);
const okScreen = fake(["x.test.ts > a screen test PASSED"]);

function runRunner(env: Record<string, string>) {
  const r = spawnSync(node, [runner], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe("test runner", () => {
  it("runner runs server and screen tests and prints each by name", () => {
    const r = runRunner({
      TESTS_BACKEND_CMD: fake(["tests/test_a.py::test_one PASSED", "1 passed in 0.1s"]),
      TESTS_SCREEN_CMD: okScreen,
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain("tests/test_a.py::test_one PASSED");
    expect(r.out).toContain("a screen test PASSED");
  });

  it("frontend npm test script uses the shared runner", () => {
    const rootPkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
    const fePkg = JSON.parse(readFileSync(path.join(root, "frontend", "package.json"), "utf8"));
    expect(rootPkg.scripts.test).toContain("scripts/run-tests.mjs");
    expect(fePkg.scripts.test).toContain("scripts/run-tests.mjs");
    expect(fePkg.scripts["test:ui"]).toContain("vitest run");
  });

  it("a failing server test fails the whole run even if screen tests pass", () => {
    const r = runRunner({
      TESTS_BACKEND_CMD: fake(["tests/test_a.py::test_one FAILED", "1 failed, 2 passed"], 1),
      TESTS_SCREEN_CMD: okScreen,
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("a screen test PASSED");
  });

  it("with no usable Python it fails loudly with setup steps and never passes", () => {
    const r = runRunner({
      TESTS_UV: "uv-does-not-exist",
      TESTS_FALLBACK_PYTHONS: "",
      TESTS_SCREEN_CMD: okScreen,
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("uv sync");
  });

  it("each server test runs once", () => {
    expect(existsSync(path.join(root, "frontend", "src", "bookmarksBackend.test.ts"))).toBe(false);
    const r = runRunner({
      TESTS_BACKEND_CMD: fake(["tests/test_a.py::test_one PASSED", "1 passed"]),
      TESTS_SCREEN_CMD: okScreen,
    });
    expect(r.out.match(/test_one PASSED/g)).toHaveLength(1);
  });
});
