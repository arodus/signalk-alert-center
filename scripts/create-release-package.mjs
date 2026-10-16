import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPackageManifest } from "./package-archive.mjs";

const packageJsonPath = "package.json";
const originalPackageJson = readFileSync(packageJsonPath, "utf8");
const packageJson = JSON.parse(originalPackageJson);
const git = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});
if (git.status !== 0)
  throw new Error(`git rev-parse failed with exit code ${git.status ?? 1}`);
const gitHead = git.stdout.trim();
if (!/^[0-9a-f]{40}$/.test(gitHead))
  throw new Error(`git rev-parse returned an invalid commit SHA: ${gitHead}`);

packageJson.gitHead = gitHead;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

const npmCache = mkdtempSync(join(tmpdir(), "alert-center-npm-cache-"));
const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : "npm";
const npmArgs = npmCli ? [npmCli, "pack", "--json"] : ["pack", "--json"];
let packed;
try {
  packed = spawnSync(npmCommand, npmArgs, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, npm_config_cache: npmCache },
  });
} finally {
  writeFileSync(packageJsonPath, originalPackageJson);
  rmSync(npmCache, { recursive: true, force: true });
}
if (packed.status !== 0)
  throw new Error(
    `npm pack failed with exit code ${packed.status ?? 1}: ${packed.error?.message || packed.stderr?.trim() || packed.stdout?.trim() || "unknown error"}`,
  );

const report = JSON.parse(packed.stdout)[0];
if (!report?.filename)
  throw new Error("npm pack did not return a package filename");

const packageFile = report.filename;
const packedManifest = readPackageManifest(packageFile);
if (packedManifest.gitHead !== gitHead)
  throw new Error(
    `release package gitHead mismatch: expected ${gitHead}, found ${packedManifest.gitHead ?? "missing"}`,
  );
const checksumFile = `${packageFile}.sha256`;
const checksum = createHash("sha256")
  .update(readFileSync(packageFile))
  .digest("hex");
writeFileSync(checksumFile, `${checksum}  ${packageFile}\n`);

if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `package-file=${packageFile}\nchecksum-file=${checksumFile}\n`,
  );

console.log(`Created ${packageFile} and ${checksumFile} from ${gitHead}`);
