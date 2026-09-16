import { rmSync } from "node:fs";
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
