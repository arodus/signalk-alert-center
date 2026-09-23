import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectory = mkdtempSync(
  join(tmpdir(), "alert-center-package-smoke-"),
);
const npmCache = join(temporaryDirectory, "npm-cache");
let packageFile;

try {
  const pack = spawnSync("npm", ["pack", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, npm_config_cache: npmCache },
  });
  if (pack.status !== 0)
    throw new Error(`npm pack failed with exit code ${pack.status ?? 1}`);
  packageFile = JSON.parse(pack.stdout)[0]?.filename;
  if (!packageFile)
    throw new Error("npm pack did not return a package filename");

  const installRoot = join(temporaryDirectory, "signalk-data");
  const install = spawnSync(
    "npm",
    [
      "install",
      "--prefix",
      installRoot,
      resolve(packageFile),
      "--ignore-scripts",
      "--omit=dev",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, npm_config_cache: npmCache },
    },
  );
  if (install.status !== 0)
    throw new Error(install.stderr.trim() || "npm package installation failed");

  const installedRoot = join(
    installRoot,
    "node_modules",
    "signalk-alert-center",
  );
  const installedPackage = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  );
  if (installedPackage.signalKPlugin?.id !== "signalk-alert-center")
    throw new Error("Installed package has the wrong Signal K plugin id");
  for (const required of [
    installedPackage.main,
    "public/index.html",
    "public/app.js",
    "public/styles.css",
    "public/remoteEntry.js",
  ])
    if (!existsSync(join(installedRoot, required)))
      throw new Error(`Installed package is missing ${required}`);

  const require = createRequire(import.meta.url);
  const pluginFactory = require(join(installedRoot, installedPackage.main));
  if (typeof pluginFactory !== "function")
    throw new Error("Installed package entry point is not a plugin factory");

  console.log("Packed plugin installs and exposes its runtime and web app.");
} finally {
  if (packageFile) rmSync(resolve(packageFile), { force: true });
  rmSync(temporaryDirectory, { recursive: true, force: true });
}
