// Runs the whole test suite: the server's pytest tests and the screen's vitest
// tests, both verbose (each test shown by name). Fails if either fails, and
// fails if the server tests could not be run. Used by `npm test` in the repo
// root and in frontend/.
//
// Env overrides (used only by frontend/src/testRunner.test.ts):
//   TESTS_BACKEND_CMD       JSON array: replaces the pytest command
//   TESTS_SCREEN_CMD        JSON array: replaces the vitest command
//   TESTS_UV                name of the uv program (default "uv")
//   TESTS_FALLBACK_PYTHONS  path-delimited list of Pythons to try if uv can't run
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const backend = path.join(root, "backend");
const frontend = path.join(root, "frontend");

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(cmd, args, { cwd, env: process.env });
    p.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    p.stderr.on("data", (d) => { out += d; process.stderr.write(d); });
    p.on("error", (e) => resolve({ code: null, out, error: e }));
    p.on("close", (code) => resolve({ code, out, error: null }));
  });
}

const started = (out) => /test session starts/.test(out);
const ranSome = (out) => /\b[1-9]\d* passed\b/.test(out);

const setupHelp =
  "Cannot run the server tests, so this test run fails on purpose.\n" +
  "Set them up with: install uv (https://docs.astral.sh/uv/), then run `cd backend && uv sync`.\n" +
  "(A Python with pytest, fastapi and httpx installed also works: put it at backend/.venv.)";

const backendOverride = process.env.TESTS_BACKEND_CMD;

async function runBackend() {
  if (backendOverride) {
    const [c, ...a] = JSON.parse(backendOverride);
    return run(c, a, backend);
  }
  console.log("== Server tests (pytest) ==");
  const uv = process.env.TESTS_UV || "uv";
  // uv builds the environment from backend/pyproject.toml on the fly, so no .venv is needed.
  const r = await run(uv, ["run", "--project", backend, "pytest", "-v", "-p", "no:cacheprovider"], backend);
  if (!r.error && started(r.out)) return r;
  console.log(`uv could not run pytest (${r.error ? r.error.message : "exit " + r.code}); trying a local Python.`);
  const fallbacks =
    process.env.TESTS_FALLBACK_PYTHONS !== undefined
      ? process.env.TESTS_FALLBACK_PYTHONS.split(path.delimiter).filter(Boolean)
      : [
          path.join(backend, ".venv", "bin", "python"),
          // worktrees live in <main>/.claude/worktrees/<name>
          path.join(root, "..", "..", "..", "backend", ".venv", "bin", "python"),
        ];
  for (const py of fallbacks) {
    if (!existsSync(py)) continue;
    const probe = spawnSync(py, ["-c", "import pytest, fastapi, httpx"], { cwd: backend });
    if (probe.status !== 0) continue;
    return run(py, ["-m", "pytest", "-v", "-p", "no:cacheprovider"], backend);
  }
  return { code: null, out: "", error: new Error("no usable Python") };
}

async function runScreen() {
  console.log("\n== Screen tests (vitest) ==");
  const override = process.env.TESTS_SCREEN_CMD;
  const [c, ...a] = override ? JSON.parse(override) : ["npm", "run", "test:ui"];
  return run(c, a, frontend);
}

const be = await runBackend();
const beStarted = backendOverride ? true : started(be.out);
const beOk = !be.error && be.code === 0 && beStarted && ranSome(be.out);
if (!beOk) {
  if (be.error || !beStarted) console.error("\n" + setupHelp);
  else if (be.code === 0) console.error("\nThe server tests passed but none ran, so this test run fails.");
  else console.error("\nServer tests FAILED.");
}
const fe = await runScreen();
const feOk = !fe.error && fe.code === 0;
if (!feOk) console.error("\nScreen tests FAILED.");
console.log(`\nServer tests: ${beOk ? "passed" : "FAILED"}; screen tests: ${feOk ? "passed" : "FAILED"}`);
process.exit(beOk && feOk ? 0 : 1);
