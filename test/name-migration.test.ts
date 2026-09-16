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
import { afterEach, describe, expect, test } from "vitest";

const temporaryDirectories: string[] = [];
const script = resolve("scripts/migrate-name.mjs");

function dataDirectory() {
  const directory = mkdtempSync(join(tmpdir(), "alert-center-migration-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "plugin-config-data"));
  return directory;
}

function run(directory: string) {
  return spawnSync(process.execPath, [script, "--data-dir", directory], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("project-name migration", () => {
  test("moves existing settings verbatim without changing secrets or database paths", () => {
    const directory = dataDirectory();
    const oldPath = join(
      directory,
      "plugin-config-data",
      "signalk-persistent-notifier.json",
    );
    const newPath = join(
      directory,
      "plugin-config-data",
      "signalk-alert-center.json",
    );
    const saved = `${JSON.stringify({
      enabled: true,
      configuration: {
        storage: { path: "persistent-notifier.sqlite" },
        notifiers: [{ type: "ntfy", token: "do-not-log-this" }],
      },
    })}\n`;
    writeFileSync(oldPath, saved, { mode: 0o600 });

    const result = run(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain("do-not-log-this");
    expect(readFileSync(newPath, "utf8")).toBe(saved);
    expect(() => readFileSync(oldPath)).toThrow();
  });

  test("refuses to overwrite when old and new settings both exist", () => {
    const directory = dataDirectory();
    const configDirectory = join(directory, "plugin-config-data");
    const oldPath = join(configDirectory, "signalk-persistent-notifier.json");
    const newPath = join(configDirectory, "signalk-alert-center.json");
    writeFileSync(oldPath, "old\n");
    writeFileSync(newPath, "new\n");

    const result = run(directory);

    expect(result.status).toBe(1);
    expect(readFileSync(oldPath, "utf8")).toBe("old\n");
    expect(readFileSync(newPath, "utf8")).toBe("new\n");
  });

  test("is idempotent after migration", () => {
    const directory = dataDirectory();
    const newPath = join(
      directory,
      "plugin-config-data",
      "signalk-alert-center.json",
    );
    writeFileSync(newPath, "saved\n");

    const result = run(directory);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already using the new plugin id");
    expect(readFileSync(newPath, "utf8")).toBe("saved\n");
  });
});
