import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    hookTimeout: 60_000,
    include: ["packages/**/*.integration.test.ts"],
    passWithNoTests: true,
    testTimeout: 60_000,
  },
});
