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

const npmCache = mkdtempSync(join(tmpdir(), "persistent-notifier-npm-cache-"));
const packed = spawnSync("npm", ["pack", "--json"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
  env: { ...process.env, npm_config_cache: npmCache },
});
rmSync(npmCache, { recursive: true, force: true });
if (packed.status !== 0)
  throw new Error(`npm pack failed with exit code ${packed.status ?? 1}`);

const report = JSON.parse(packed.stdout)[0];
if (!report?.filename)
  throw new Error("npm pack did not return a package filename");

const packageFile = report.filename;
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

console.log(`Created ${packageFile} and ${checksumFile}`);
