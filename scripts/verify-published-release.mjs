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
const attempts = Number.parseInt(
  process.env.NPM_PUBLISH_VERIFY_ATTEMPTS ?? "30",
  10,
);
const delayMs = Number.parseInt(
  process.env.NPM_PUBLISH_VERIFY_DELAY_MS ?? "10000",
  10,
);
if (!Number.isInteger(attempts) || attempts < 1)
  throw new Error("NPM_PUBLISH_VERIFY_ATTEMPTS must be a positive integer");
if (!Number.isInteger(delayMs) || delayMs < 0)
  throw new Error("NPM_PUBLISH_VERIFY_DELAY_MS must be a non-negative integer");

const npmCache = mkdtempSync(join(tmpdir(), "alert-center-npm-cache-"));
try {
  let lastFailure = "the package is not visible in the npm registry";
  let verified = false;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(
      npmCommand,
      [
        ...npmArgs,
        "view",
        `${packageJson.name}@${packageJson.version}`,
        "gitHead",
        "--json",
        "--prefer-online",
      ],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, npm_config_cache: npmCache },
      },
    );

    if (result.status === 0) {
      try {
        const publishedGitHead = result.stdout.trim()
          ? JSON.parse(result.stdout.trim())
          : undefined;
        if (publishedGitHead === expectedGitHead) {
          verified = true;
          break;
        }
        lastFailure = `published gitHead mismatch: expected ${expectedGitHead}, found ${publishedGitHead ?? "missing"}`;
      } catch (error) {
        lastFailure = `npm returned invalid JSON: ${error.message}`;
      }
    } else {
      lastFailure =
        result.stderr.trim() ||
        `npm view failed with exit code ${result.status ?? 1}`;
    }

    if (attempt < attempts) {
      console.log(
        `npm registry has not exposed the verified release yet (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms.`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  if (!verified)
    throw new Error(
      `unable to verify ${packageJson.name}@${packageJson.version} after ${attempts} attempts: ${lastFailure}`,
    );
} finally {
  rmSync(npmCache, { recursive: true, force: true });
}

console.log(
  `${packageJson.name}@${packageJson.version} identifies release commit ${expectedGitHead}.`,
);
