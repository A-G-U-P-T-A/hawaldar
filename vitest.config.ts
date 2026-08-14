import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@hawaldar/shared": join(root, "packages/shared/src/index.ts"),
      "@hawaldar/engagement": join(root, "packages/engagement/src/index.ts"),
      "@hawaldar/security-graph": join(root, "packages/security-graph/src/index.ts"),
      "@hawaldar/tool-registry": join(root, "tools/registry/src/index.ts"),
      "@hawaldar/sandbox": join(root, "packages/sandbox/src/index.ts"),
    },
  },
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "apps/*/src/**/*.test.ts",
      "tools/*/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    environment: "node",
  },
});
