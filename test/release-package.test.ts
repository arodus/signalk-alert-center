import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

import { readPackageManifest } from "../scripts/package-archive.mjs";

it("stamps the release tarball with gitHead without changing the checkout", () => {
  const work = mkdtempSync(join(tmpdir(), "alert-center-release-package-"));
  const git = (...args: string[]) => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=Release Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: work, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };

  try {
    mkdirSync(join(work, "scripts"));
    copyFileSync(
      resolve("scripts/create-release-package.mjs"),
      join(work, "scripts/create-release-package.mjs"),
    );
    copyFileSync(
      resolve("scripts/package-archive.mjs"),
      join(work, "scripts/package-archive.mjs"),
    );
    const originalPackageJson = `${JSON.stringify(
      {
        name: "release-package-fixture",
        version: "1.2.3",
        files: ["index.js"],
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(work, "package.json"), originalPackageJson);
    writeFileSync(join(work, "index.js"), "export const fixture = true;\n");
    git("init", "-b", "main");
    git("add", ".");
    git("commit", "-m", "Release fixture");
    const expectedGitHead = git("rev-parse", "HEAD");

    const result = spawnSync(
      process.execPath,
      ["scripts/create-release-package.mjs"],
      { cwd: work, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(work, "package.json"), "utf8")).toBe(
      originalPackageJson,
    );

    const packageFile = join(work, "release-package-fixture-1.2.3.tgz");
    expect(readPackageManifest(packageFile).gitHead).toBe(expectedGitHead);
    const expectedChecksum = createHash("sha256")
      .update(readFileSync(packageFile))
      .digest("hex");
    expect(readFileSync(`${packageFile}.sha256`, "utf8")).toBe(
      `${expectedChecksum}  release-package-fixture-1.2.3.tgz\n`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
