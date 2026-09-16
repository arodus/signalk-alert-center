import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const tag = process.argv[2];
if (!tag) throw new Error("Pass the release tag");

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(packageJson.version))
  throw new Error(
    `Package version ${packageJson.version} is not a supported release version`,
  );
const expectedTag = `v${packageJson.version}`;
if (tag !== expectedTag)
  throw new Error(
    `Tag ${tag} does not match package version ${packageJson.version}`,
  );

const git = (...args) => {
  const result = spawnSync("git", args, { encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
};

if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag")
  throw new Error(`${tag} must be an annotated tag`);
if (git("status", "--porcelain"))
  throw new Error("Release checkout contains uncommitted or untracked files");

git("fetch", "origin", "main");
const ancestry = spawnSync(
  "git",
  ["merge-base", "--is-ancestor", "HEAD", "origin/main"],
  { encoding: "utf8" },
);
if (ancestry.status !== 0)
  throw new Error(`${tag} does not point to a commit contained in origin/main`);

const notes = spawnSync(
  process.execPath,
  ["scripts/release-notes.mjs", packageJson.version],
  { encoding: "utf8" },
);
if (notes.status !== 0)
  throw new Error(notes.stderr.trim() || "Release notes validation failed");

console.log(`${tag} is an annotated main-branch release with matching notes.`);
