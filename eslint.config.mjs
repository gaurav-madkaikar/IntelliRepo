import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/.next/**", "**/coverage/**", "**/dist/**", "**/node_modules/**", "**/*.d.ts"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      "no-undef": "off",
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@intellirepo/*/src/*", "@intellirepo/*/dist/*"],
              message: "Import through the package's public interface instead.",
            },
          ],
        },
      ],
    },
  },
);
