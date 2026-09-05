import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "node:sqlite": path.resolve(__dirname, "sqlite.ts"),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
