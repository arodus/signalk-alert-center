import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const failures = [];
const requireValue = (condition, message) => {
  if (!condition) failures.push(message);
};

requireValue(
  packageJson.name === "signalk-alert-center",
  "unexpected package name",
);
requireValue(
  packageJson.main === "dist/plugin.js",
  "main must point to dist/plugin.js",
);
requireValue(
  packageJson.types === "dist/plugin.d.ts",
  "types must point to dist/plugin.d.ts",
);
requireValue(packageJson.license === "MIT", "license must be MIT");
requireValue(Boolean(packageJson.author), "author metadata is required");
requireValue(
  Boolean(packageJson.repository?.url),
  "repository metadata is required",
);
requireValue(Boolean(packageJson.homepage), "homepage metadata is required");
requireValue(
  Boolean(packageJson.bugs?.url),
  "bug tracker metadata is required",
);
requireValue(
  packageJson.keywords?.includes("signalk-node-server-plugin"),
  "Signal K plugin keyword is required",
);
requireValue(
  packageJson.keywords?.includes("signalk-category-notifications"),
  "Signal K notification category keyword is required",
);
requireValue(
  packageJson.signalKPlugin?.id === packageJson.name,
  "Signal K plugin id must match the package name",
);
requireValue(
  packageJson.signalk?.appIcon === "./icon-192.png",
  "Signal K app icon must reference public/icon-192.png",
);
requireValue(
  packageJson.signalk?.displayName === "Signal K Alert Center",
  "Signal K display name is required",
);
requireValue(
  packageJson.engines?.node === ">=22.5",
  "Node compatibility must be explicit",
);
requireValue(
  existsSync(packageJson.main),
  `missing built entry point ${packageJson.main}`,
);
requireValue(
  existsSync(packageJson.types),
  `missing type entry point ${packageJson.types}`,
);
requireValue(existsSync("LICENSE"), "LICENSE file is required");
requireValue(
  existsSync("public/remoteEntry.js"),
  "custom settings panel is missing public/remoteEntry.js",
);

const npmCache = mkdtempSync(join(tmpdir(), "alert-center-npm-cache-"));
const packed = spawnSync(
  "npm",
  ["pack", "--dry-run", "--json", "--ignore-scripts"],
  {
    encoding: "utf8",
    env: { ...process.env, npm_config_cache: npmCache },
  },
);
rmSync(npmCache, { recursive: true, force: true });
if (packed.status !== 0) {
  failures.push(
    `npm pack failed: ${packed.stderr.trim() || packed.stdout.trim()}`,
  );
} else {
  let report;
  try {
    report = JSON.parse(packed.stdout)[0];
  } catch (error) {
    failures.push(`npm pack returned invalid JSON: ${String(error)}`);
  }
  if (report) {
    const paths = report.files.map((file) => file.path);
    for (const required of [
      "LICENSE",
      "README.md",
      "package.json",
      "dist/plugin.js",
      "dist/plugin.d.ts",
      "public/index.html",
      "public/app.js",
      "public/styles.css",
      "public/remoteEntry.js",
      "public/icon-192.png",
      "public/icon-512.png",
    ])
      requireValue(paths.includes(required), `package is missing ${required}`);

    const allowed = /^(LICENSE|README\.md|package\.json|dist\/|public\/)/;
    for (const path of paths)
      requireValue(allowed.test(path), `unexpected packaged file: ${path}`);

    const forbidden = [
      /(^|\/)\.env($|\.)/,
      /\.sqlite(?:-shm|-wal)?$/,
      /(^|\/)(?:test|test-results|playwright-report|src)\//,
      /\.(?:key|pem|p12)$/,
      /^dist\/audio\//,
    ];
    for (const path of paths)
      for (const pattern of forbidden)
        requireValue(!pattern.test(path), `forbidden packaged file: ${path}`);
  }
}

if (failures.length) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exit(1);
}

console.log("Package metadata and contents are release-safe.");
