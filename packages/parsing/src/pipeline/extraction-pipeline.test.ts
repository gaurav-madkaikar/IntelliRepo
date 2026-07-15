import {
  createConfidence,
  createEntityStableKey,
  createProvenance,
  type EntityFact,
} from "@intellirepo/domain";
import { describe, expect, it, vi } from "vitest";

import { languageExtractorContract } from "../contract-tests/language-extractor-contract.js";
import { createDiagnostic } from "../diagnostics/diagnostic.js";
import type { LanguageExtractor } from "../interfaces/language-extractor.js";
import { AdapterRegistry } from "./adapter-registry.js";
import { ExtractionPipeline } from "./extraction-pipeline.js";
import { createDefaultAdapterRegistry } from "./default-registry.js";

function moduleEntity(artifactPath: string, revisionId: string): EntityFact {
  return {
    attributes: { path: artifactPath },
    kind: "module",
    language: "typescript",
    name: artifactPath,
    provenance: createProvenance({
      artifactPath,
      confidence: createConfidence({ level: "confirmed", reason: "fixture", score: 1 }),
      evidence: "fixture",
      extractor: "fixture",
      range: { end: { column: 2, line: 1 }, start: { column: 1, line: 1 } },
      repositoryRevision: revisionId,
    }),
    qualifiedName: artifactPath,
    stableKey: createEntityStableKey({
      kind: "module",
      language: "typescript",
      qualifiedName: artifactPath,
      repositoryId: "repository-pipeline",
    }),
  };
}

class IsolatingFakeExtractor implements LanguageExtractor {
  public readonly id = "fake-typescript";
  public readonly language = "typescript" as const;

  public supports(): boolean {
    return true;
  }

  public extract(context: Parameters<LanguageExtractor["extract"]>[0]) {
    return Promise.resolve(
      context.artifacts
        .filter(({ path }) => path.endsWith(".ts"))
        .map((artifact) =>
          artifact.content === "MALFORMED"
            ? {
                artifactPath: artifact.path,
                diagnostics: [
                  createDiagnostic({
                    artifactPath: artifact.path,
                    code: "FAKE_MALFORMED",
                    message: "Malformed fixture",
                    severity: "error",
                  }),
                ],
                entities: [],
                mode: "syntax-fallback" as const,
                relationships: [],
                unresolvedReferences: [],
              }
            : {
                artifactPath: artifact.path,
                diagnostics: [],
                entities: [moduleEntity(artifact.path, context.revisionId)],
                mode: "semantic" as const,
                relationships: [],
                unresolvedReferences: [],
              },
        ),
    );
  }
}

describe("ExtractionPipeline", () => {
  it("extracts mixed Java and Kotlin references with the default registry", async () => {
    const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
      artifacts: [
        {
          artifactKind: "code",
          content: "package mixed; public interface SharedApi { void run(); }",
          language: "java",
          path: "src/main/java/mixed/SharedApi.java",
        },
        {
          artifactKind: "code",
          content: "package mixed\nclass KotlinService : SharedApi { fun run() {} }",
          language: "kotlin",
          path: "src/main/kotlin/mixed/KotlinService.kt",
        },
      ],
      repositoryId: "repository-mixed-pipeline",
      revisionId: "revision-mixed-pipeline",
    });

    expect(result.artifacts.flatMap(({ relationships }) => relationships)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "IMPLEMENTS",
          provenance: expect.objectContaining({ extractor: "cross-language-resolver" }),
        }),
      ]),
    );
    expect(
      result.artifacts
        .flatMap(({ entities }) => entities)
        .filter(({ name }) => name === "SharedApi" || name === "KotlinService"),
    ).toHaveLength(2);
  });

  it("detects the project, selects adapters, and returns storage-neutral facts", async () => {
    const registry = new AdapterRegistry().registerExtractor(new IsolatingFakeExtractor());
    const adapter = {
      enrich: vi.fn((_context, artifacts) => Promise.resolve(artifacts)),
      framework: "nestjs",
      id: "fake-nest",
      supports: (detection: { frameworks: readonly string[] }) =>
        detection.frameworks.includes("nestjs"),
    };
    registry.registerFrameworkAdapter(adapter);
    const result = await new ExtractionPipeline(registry).extract({
      artifacts: [
        {
          artifactKind: "build",
          content: '{"dependencies":{"@nestjs/core":"latest"}}',
          path: "package.json",
        },
        {
          artifactKind: "code",
          content: "export {};",
          language: "typescript",
          path: "src/index.ts",
        },
      ],
      repositoryId: "repository-pipeline",
      revisionId: "revision-pipeline",
    });

    expect(result.detection).toMatchObject({
      frameworks: ["nestjs"],
      languages: ["typescript"],
      sourceRoots: ["src"],
    });
    expect(adapter.enrich).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/created_at|repository_id|owner_artifact_id/u);
  });

  it("turns invalid facts into extractor failure diagnostics before persistence", async () => {
    const invalidExtractor = new IsolatingFakeExtractor();
    invalidExtractor.extract = (context) =>
      Promise.resolve([
        {
          artifactPath: "src/index.ts",
          diagnostics: [],
          entities: [
            {
              ...moduleEntity("src/index.ts", context.revisionId),
              provenance: {
                ...moduleEntity("src/index.ts", context.revisionId).provenance,
                repositoryRevision: "wrong-revision",
              },
            },
          ],
          mode: "semantic",
          relationships: [],
          unresolvedReferences: [],
        },
      ]);
    const result = await new ExtractionPipeline(
      new AdapterRegistry().registerExtractor(invalidExtractor),
    ).extract({
      artifacts: [
        {
          artifactKind: "code",
          content: "export {};",
          language: "typescript",
          path: "src/index.ts",
        },
      ],
      repositoryId: "repository-pipeline",
      revisionId: "revision-pipeline",
    });

    expect(result.artifacts[0]).toMatchObject({
      diagnostics: [expect.objectContaining({ code: "EXTRACTOR_FAILURE" })],
      entities: [],
    });
  });
});

languageExtractorContract(() => new IsolatingFakeExtractor());
