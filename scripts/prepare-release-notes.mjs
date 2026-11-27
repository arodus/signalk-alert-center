import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

export const rollbackPrompt =
  "<!-- RELEASE REVIEW: replace with upgrade and rollback guidance -->";

export function prepareNotes(changelog, version, date, generate) {
  if (!/^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/.test(version))
    throw new Error("Set a supported release version in package.json first.");
  const unreleased = /^## \[Unreleased\][ \t]*\r?$/m.exec(changelog);
  if (!unreleased) throw new Error("Missing [Unreleased] heading.");
  const start = unreleased.index + unreleased[0].length;
  const tail = changelog.slice(start);
  const previous = /^## \[([^\]]+)\](?: - [^\r\n]+)?\r?$/m.exec(tail);
  if (!previous) throw new Error("Cannot determine the previous release tag.");
  if (
    changelog
      .split(/\r?\n/)
      .some((line) => line.split(" - ")[0] === `## [${version}]`)
  )
    throw new Error(
      `Release ${version} already exists. Existing notes were kept.`,
    );

  const body = generate(`v${previous[1]}`, `v${version}`).trim();
  if (!body) throw new Error("GitHub returned empty release notes.");
  // The publisher treats level-two headings as release boundaries.
  const changes = body.replace(/^(#{1,2}) /gm, "### ").replace(/^\* /gm, "- ");
  const legacy = tail.slice(0, previous.index).trim();
  const sections = [
    `## [${version}] - ${date}`,
    "### Upgrade and rollback",
    rollbackPrompt,
  ];
  if (legacy) sections.push("### Previously recorded notes", legacy);
  sections.push(changes);
  return (
    changelog.slice(0, start) +
    "\n\n" +
    sections.join("\n\n") +
    "\n\n" +
    tail.slice(previous.index)
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = "CHANGELOG.md";
  const { version } = JSON.parse(readFileSync("package.json", "utf8"));
  const notes = prepareNotes(
    readFileSync(file, "utf8"),
    version,
    new Date().toISOString().slice(0, 10),
    (previous, tag) => {
      const target = execFileSync(
        "git",
        ["merge-base", "HEAD", "origin/main"],
        { encoding: "utf8" },
      ).trim();
      return execFileSync(
        "gh",
        [
          "api",
          "repos/arodus/signalk-alert-center/releases/generate-notes",
          "-f",
          `tag_name=${tag}`,
          "-f",
          `previous_tag_name=${previous}`,
          "-f",
          `target_commitish=${target}`,
          "--jq",
          ".body",
        ],
        { encoding: "utf8" },
      );
    },
  );
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, notes, { flag: "wx" });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
  console.log(
    "Drafted CHANGELOG.md. Review the linked PRs and complete Upgrade and rollback.",
  );
}
