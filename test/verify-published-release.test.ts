import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("retries while a newly published package is not yet visible", () => {
  const work = mkdtempSync(join(tmpdir(), "alert-center-publish-verify-"));
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
    writeFileSync(
      join(work, "package.json"),
      `${JSON.stringify({ name: "publish-fixture", version: "1.2.3" })}\n`,
    );
    writeFileSync(join(work, "index.js"), "export const fixture = true;\n");
    writeFileSync(
      join(work, "scripts", "fake-npm.mjs"),
      `import { readFileSync, writeFileSync } from "node:fs";
const count = Number(readFileSync(process.env.FAKE_NPM_COUNT, "utf8")) + 1;
writeFileSync(process.env.FAKE_NPM_COUNT, String(count));
if (count < 3) {
  console.error("npm error 404 package is still processing");
  process.exit(1);
}
console.log(JSON.stringify(process.env.FAKE_GIT_HEAD));
`,
    );
    writeFileSync(join(work, "count"), "0");
    writeFileSync(
      join(work, "scripts", "verify-published-release.mjs"),
      readFileSync(resolve("scripts/verify-published-release.mjs"), "utf8"),
    );
    git("init", "-b", "main");
    git("add", ".");
    git("commit", "-m", "Release fixture");
    const expectedGitHead = git("rev-parse", "HEAD");

    const result = spawnSync(
      process.execPath,
      ["scripts/verify-published-release.mjs"],
      {
        cwd: work,
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_PUBLISH_VERIFY_NPM_CLI: join(work, "scripts", "fake-npm.mjs"),
          FAKE_GIT_HEAD: expectedGitHead,
          FAKE_NPM_COUNT: join(work, "count"),
          NPM_PUBLISH_VERIFY_ATTEMPTS: "3",
          NPM_PUBLISH_VERIFY_DELAY_MS: "1",
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(work, "count"), "utf8")).toBe("3");
    expect(result.stdout).toContain("attempt 2/3");
    expect(result.stdout).toContain(
      `identifies release commit ${expectedGitHead}`,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
