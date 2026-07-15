import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
    },
    exclude: ["**/*.integration.test.ts", "**/node_modules/**", "**/.git/**"],
    include: ["**/src/**/*.test.ts"],
    passWithNoTests: true,
  },
});
