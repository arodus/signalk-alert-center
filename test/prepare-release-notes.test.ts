import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import {
  prepareNotes,
  rollbackPrompt,
} from "../scripts/prepare-release-notes.mjs";

const history = "## [1.0.0] - 2026-01-01\n\nOlder release.\n";
const changelog =
  "# Changelog\n\n## [Unreleased]\n\nLegacy note.\n\n" + history;
const body =
  "## What's Changed\n### Fixes\n* fix: retry by @crew in https://github.com/example/repo/pull/123\n\n## New Contributors\n* @crew contributed.";

it("collects the PR range, keeps existing notes and publishes exactly the reviewed text", () => {
  const generate = vi.fn(() => body);
  const draft = prepareNotes(changelog, "1.1.0-rc.1", "2026-11-27", generate);
  expect(generate).toHaveBeenCalledWith("v1.0.0", "v1.1.0-rc.1");
  expect(draft).toContain("## [Unreleased]\n\n## [1.1.0-rc.1] - 2026-11-27");
  expect(draft.endsWith(history)).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "release-review-"));
  const extract = () =>
    execFileSync(
      process.execPath,
      [resolve("scripts/release-notes.mjs"), "v1.1.0-rc.1", "--require-review"],
      { cwd: root, encoding: "utf8", stdio: "pipe" },
    );
  try {
    for (const unfinished of [
      draft,
      draft.replace(rollbackPrompt, ""),
      draft.replace("### Upgrade and rollback", "").replace(rollbackPrompt, ""),
    ]) {
      writeFileSync(join(root, "CHANGELOG.md"), unfinished);
      expect(extract).toThrow(/Complete the Upgrade and rollback review/);
    }
    writeFileSync(
      join(root, "CHANGELOG.md"),
      draft.replace(
        rollbackPrompt,
        "Restore the pre-upgrade backup to downgrade.",
      ),
    );
    expect(extract()).toBe(
      "### Upgrade and rollback\n\nRestore the pre-upgrade backup to downgrade.\n\n### Previously recorded notes\n\nLegacy note.\n\n### What's Changed\n### Fixes\n- fix: retry by @crew in https://github.com/example/repo/pull/123\n\n### New Contributors\n- @crew contributed.\n",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("protects existing release sections and rejects an empty GitHub response", () => {
  const empty = vi.fn(() => "");
  expect(() => prepareNotes(changelog, "1.0.0", "2026-11-27", empty)).toThrow(
    /already exists/,
  );
  expect(empty).not.toHaveBeenCalled();
  expect(() => prepareNotes(changelog, "1.1.0", "2026-11-27", empty)).toThrow(
    /empty release notes/,
  );
});
