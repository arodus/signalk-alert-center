import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`,
    );
  return result.stdout.trim();
};

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const expectedGitHead = run("git", ["rev-parse", "HEAD"]);
if (!/^[0-9a-f]{40}$/.test(expectedGitHead))
  throw new Error(
    `git rev-parse returned an invalid commit SHA: ${expectedGitHead}`,
  );

const npmCli = process.env.npm_execpath;
const npmCommand = npmCli ? process.execPath : "npm";
const npmArgs = npmCli ? [npmCli] : [];
const npmCache = mkdtempSync(join(tmpdir(), "alert-center-npm-cache-"));
try {
  const publishedGitHeadJson = run(
    npmCommand,
    [
      ...npmArgs,
      "view",
      `${packageJson.name}@${packageJson.version}`,
      "gitHead",
      "--json",
      "--prefer-online",
    ],
    { env: { ...process.env, npm_config_cache: npmCache } },
  );
  const publishedGitHead = publishedGitHeadJson
    ? JSON.parse(publishedGitHeadJson)
    : undefined;
  if (publishedGitHead !== expectedGitHead)
    throw new Error(
      `published gitHead mismatch: expected ${expectedGitHead}, found ${publishedGitHead ?? "missing"}`,
    );
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

console.log(
  `${packageJson.name}@${packageJson.version} identifies release commit ${expectedGitHead}.`,
);
