import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    hookTimeout: 60_000,
    include: ["apps/**/*.integration.test.ts", "packages/**/*.integration.test.ts"],
    passWithNoTests: true,
    testTimeout: 60_000,
  },
});
