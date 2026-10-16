import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";

const BLOCK_SIZE = 512;

const stringField = (block, start, length) =>
  block
    .subarray(start, start + length)
    .toString("utf8")
    .replace(/\0.*$/s, "")
    .trim();

export function readPackageManifest(archivePath) {
  const archive = gunzipSync(readFileSync(archivePath));

  for (let offset = 0; offset + BLOCK_SIZE <= archive.length;) {
    const header = archive.subarray(offset, offset + BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const name = stringField(header, 0, 100);
    const prefix = stringField(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const sizeText = stringField(header, 124, 12);
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error(`Invalid tar entry size for ${path || "unknown entry"}`);

    const contentStart = offset + BLOCK_SIZE;
    if (path === "package/package.json") {
      const content = archive
        .subarray(contentStart, contentStart + size)
        .toString("utf8");
      return JSON.parse(content);
    }

    offset = contentStart + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
  }

  throw new Error(`package/package.json is missing from ${archivePath}`);
}
