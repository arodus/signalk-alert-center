import { spawnSync } from "node:child_process";

const compose = [
  "compose",
  "-p",
  "alert-center-browser",
  "-f",
  "docker-compose.acceptance.yml",
];
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.status !== 0)
    throw new Error(`${command} failed with ${result.status}`);
};

try {
  run("docker", [
    ...compose,
    "up",
    "-d",
    "--build",
    "--wait",
    "signalk",
    "notifier-mock",
  ]);
  run("npm", ["run", "test:browser:only"]);
} finally {
  spawnSync("docker", [...compose, "down", "-v", "--remove-orphans"], {
    stdio: "inherit",
  });
}
