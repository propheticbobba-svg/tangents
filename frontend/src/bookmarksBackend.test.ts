// Runs the backend bookmark tests (backend/tests/test_bookmarks.py) so that
// `npm test` covers them. Each backend test is reported here under its own name.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

const names = [
  "test_bookmark_two_side_chats_deep_is_listed_with_its_details",
  "test_list_spans_main_and_side_chats_oldest_first_and_only_this_chat",
  "test_bookmarking_twice_keeps_one_and_removing_missing_succeeds",
  "test_removed_bookmark_leaves_list_and_message_flag",
  "test_messages_say_if_bookmarked_after_restart",
  "test_deleting_side_chat_or_whole_chat_drops_its_bookmarks",
  "test_unknown_message_or_chat_gets_404",
];

let output = "";

describe("backend bookmarks (pytest)", () => {
  beforeAll(() => {
    const backend = path.resolve(process.cwd(), "..", "backend");
    const py = path.join(backend, ".venv", "bin", "python");
    const r = spawnSync(py, ["-m", "pytest", "tests/test_bookmarks.py", "-v", "-p", "no:cacheprovider"], {
      cwd: backend,
      encoding: "utf8",
    });
    output = `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`;
  }, 110_000);

  for (const name of names) {
    it(name, () => {
      expect(output).toMatch(new RegExp(`::${name} PASSED`));
    }, 10_000);
  }
});
