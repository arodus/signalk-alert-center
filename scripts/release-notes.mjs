import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [requested, output] = args.filter((arg) => arg !== "--require-review");
if (!requested) throw new Error("Pass a release version or v-prefixed tag");

const version = requested.replace(/^v/, "");
const changelog = readFileSync("CHANGELOG.md", "utf8");
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lines = changelog.split(/\r?\n/);
const heading = new RegExp(`^## \\[${escaped}\\](?: - .+)?$`);
const start = lines.findIndex((line) => heading.test(line));
if (start < 0)
  throw new Error(`CHANGELOG.md has no release section for ${version}`);

const next = lines.findIndex(
  (line, index) => index > start && line.startsWith("## "),
);
const notes = lines
  .slice(start + 1, next < 0 ? lines.length : next)
  .join("\n")
  .trim();
if (!notes) throw new Error(`CHANGELOG.md release section ${version} is empty`);

const rollback = /^### Upgrade and rollback[ \t]*\r?$/m.exec(notes);
if (
  (!rollback && args.includes("--require-review")) ||
  notes.includes("<!-- RELEASE REVIEW:") ||
  (rollback &&
    !notes
      .slice(rollback.index + rollback[0].length)
      .split(/^#{1,3} /m, 1)[0]
      .trim())
)
  throw new Error("Complete the Upgrade and rollback review before publishing");

const rendered = `${notes}\n`;
if (output) writeFileSync(output, rendered);
else process.stdout.write(rendered);
