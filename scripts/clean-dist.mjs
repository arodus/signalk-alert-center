import { readdirSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

const distributionDirectory = fileURLToPath(
  new URL("../dist", import.meta.url),
);

if (basename(distributionDirectory) !== "dist")
  throw new Error(
    `Refusing to clean unexpected path: ${distributionDirectory}`,
  );

rmSync(distributionDirectory, { recursive: true, force: true });

const publicDirectory = fileURLToPath(new URL("../public", import.meta.url));
for (const entry of readdirSync(publicDirectory))
  if (
    entry === "remoteEntry.js" ||
    /^config-[a-f0-9]+\.js(?:\.LICENSE\.txt)?$/.test(entry)
  )
    rmSync(fileURLToPath(new URL(`../public/${entry}`, import.meta.url)), {
      force: true,
    });
