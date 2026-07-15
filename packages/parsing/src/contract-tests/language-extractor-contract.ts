import { describe, expect, it } from "vitest";

import type { LanguageExtractor } from "../interfaces/language-extractor.js";
import { detectProject } from "../pipeline/project-detector.js";

export function languageExtractorContract(createExtractor: () => LanguageExtractor): void {
  describe("LanguageExtractor contract", () => {
    it("returns one owned result per supported artifact and isolates malformed input", async () => {
      const artifacts = [
        {
          artifactKind: "code" as const,
          content: "export const healthy = true;",
          language: "typescript" as const,
          path: "src/healthy.ts",
        },
        {
          artifactKind: "code" as const,
          content: "MALFORMED",
          language: "typescript" as const,
          path: "src/malformed.ts",
        },
      ];
      const extractor = createExtractor();
      const results = await extractor.extract({
        artifacts,
        detection: detectProject(artifacts),
        repositoryId: "repository-contract",
        revisionId: "revision-contract",
      });

      expect(results.map(({ artifactPath }) => artifactPath).sort()).toEqual([
        "src/healthy.ts",
        "src/malformed.ts",
      ]);
      expect(
        results.find(({ artifactPath }) => artifactPath === "src/healthy.ts")?.entities,
      ).not.toHaveLength(0);
      expect(
        results.find(({ artifactPath }) => artifactPath === "src/malformed.ts")?.diagnostics,
      ).not.toHaveLength(0);
    });
  });
}
