import { readFileSync, writeFileSync } from "node:fs";

const requested = process.argv[2];
const output = process.argv[3];
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

const rendered = `${notes}\n`;
if (output) writeFileSync(output, rendered);
else process.stdout.write(rendered);
