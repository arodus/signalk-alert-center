import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";

it("restores an annotated remote tag flattened by checkout and rejects unsafe tags", () => {
  const root = mkdtempSync(join(tmpdir(), "alert-center-release-tag-"));
  const remote = join(root, "remote.git");
  const work = join(root, "work");
  const checkout = join(root, "checkout");
  const git = (cwd: string, ...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "tag.gpgsign=false",
        ...args,
      ],
      { cwd, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  try {
    git(root, "init", "--bare", remote);
    git(root, "init", "-b", "main", work);
    mkdirSync(join(work, "scripts"));
    copyFileSync(
      resolve("scripts/verify-release-tag.mjs"),
      join(work, "scripts/verify-release-tag.mjs"),
    );
    copyFileSync(
      resolve("scripts/release-notes.mjs"),
      join(work, "scripts/release-notes.mjs"),
    );
    writeFileSync(
      join(work, "package.json"),
      JSON.stringify({ version: "0.1.0" }),
    );
    writeFileSync(join(work, "CHANGELOG.md"), "## [0.1.0]\n\nTest release.\n");
    git(work, "add", ".");
    git(work, "commit", "-m", "Release fixture");
    git(work, "remote", "add", "origin", remote);
    git(work, "tag", "-a", "v0.1.0", "-m", "Release");
    git(work, "push", "origin", "main", "v0.1.0");
    git(root, "clone", "-b", "main", remote, checkout);
    git(checkout, "tag", "-f", "v0.1.0", "HEAD");
    expect(git(checkout, "cat-file", "-t", "refs/tags/v0.1.0")).toBe("commit");
    const verify = () =>
      spawnSync(
        process.execPath,
        ["scripts/verify-release-tag.mjs", "v0.1.0"],
        { cwd: checkout, encoding: "utf8" },
      );
    expect(verify().status).toBe(0);
    expect(git(checkout, "cat-file", "-t", "refs/tags/v0.1.0")).toBe("tag");
    git(work, "commit", "--allow-empty", "-m", "Later commit");
    git(work, "tag", "-f", "-a", "v0.1.0", "-m", "Moved tag");
    git(work, "push", "--force", "origin", "v0.1.0");
    expect(verify().stderr).toContain(
      "does not point to the checked-out commit",
    );
    git(work, "tag", "-f", "v0.1.0", "HEAD");
    git(work, "push", "--force", "origin", "v0.1.0");
    expect(verify().stderr).toContain("must be an annotated tag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
