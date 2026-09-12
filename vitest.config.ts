import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@tab-goblin/protocol": fileURLToPath(new URL("./packages/protocol/src/index.ts", import.meta.url)),
      "@tab-goblin/fixture-site/src/server.js": fileURLToPath(
        new URL("./packages/fixture-site/src/server.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "plugin/test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
