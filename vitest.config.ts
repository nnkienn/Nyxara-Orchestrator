import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@nyxara/core": fileURLToPath(
        new URL("./packages/core/src/index.ts", import.meta.url),
      ),
      "@nyxara/provider-sdk": fileURLToPath(
        new URL("./packages/provider-sdk/src/index.ts", import.meta.url),
      ),
      "@nyxara/providers": fileURLToPath(
        new URL("./packages/providers/src/index.ts", import.meta.url),
      ),
      "@nyxara/shared": fileURLToPath(
        new URL("./packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["apps/**/*.test.ts", "packages/**/*.test.ts", "tools/**/*.test.ts"],
  },
});
