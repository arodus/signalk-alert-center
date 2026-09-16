#!/usr/bin/env node

import { existsSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
let dataDirectory =
  process.env.SIGNALK_NODE_DATA_DIR || join(homedir(), ".signalk");

if (args.length > 0) {
  if (args.length !== 2 || args[0] !== "--data-dir") {
    console.error("Usage: signalk-alert-center-migrate [--data-dir PATH]");
    process.exit(2);
  }
  dataDirectory = resolve(args[1]);
}

const configDirectory = join(dataDirectory, "plugin-config-data");
const oldConfig = join(configDirectory, "signalk-persistent-notifier.json");
const newConfig = join(configDirectory, "signalk-alert-center.json");

if (existsSync(newConfig)) {
  if (existsSync(oldConfig)) {
    console.error(
      "Migration stopped: both the old and new configuration files exist. " +
        "Resolve them manually so an existing configuration is never overwritten.",
    );
    process.exit(1);
  }
  console.log(
    "Signal K Alert Center configuration is already using the new plugin id.",
  );
  process.exit(0);
}

if (!existsSync(oldConfig)) {
  console.log(
    "No old Signal K Persistent Notifier configuration was found; nothing to migrate.",
  );
  process.exit(0);
}

renameSync(oldConfig, newConfig);
console.log(
  "Moved the saved configuration to signalk-alert-center.json. " +
    "Secrets were not read or printed, and the configured SQLite path was left unchanged.",
);
