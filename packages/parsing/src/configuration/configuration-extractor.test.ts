import { describe, expect, it } from "vitest";

import { TypeScriptExtractor } from "../languages/typescript/typescript-extractor.js";
import { JavaExtractor } from "../languages/java/java-extractor.js";
import { KotlinExtractor } from "../languages/kotlin/kotlin-extractor.js";
import { AdapterRegistry } from "../pipeline/adapter-registry.js";
import { ExtractionPipeline } from "../pipeline/extraction-pipeline.js";
import { detectProject } from "../pipeline/project-detector.js";
import { ConfigurationExtractor } from "./configuration-extractor.js";

describe("ConfigurationExtractor", () => {
  it("flattens properties and YAML while redacting secret values", async () => {
    const extractor = new ConfigurationExtractor();
    const properties = {
      artifactKind: "configuration" as const,
      content: "jwt.expiryMinutes=15\ndatabase.password=do-not-store-this",
      path: "src/main/resources/application.properties",
    };
    const yaml = {
      artifactKind: "configuration" as const,
      content:
        "server:\n  port: 8080\nsecurity:\n  api-key: never-persist-this\nfeatures:\n  - dynamic",
      path: "src/main/resources/application.yml",
    };
    const context = {
      artifacts: [properties, yaml],
      detection: detectProject([properties, yaml]),
      repositoryId: "configuration-fixture",
      revisionId: "configuration-revision",
    };
    const results = [
      await extractor.extract(properties, context),
      await extractor.extract(yaml, context),
    ];
    const serialized = JSON.stringify(results);

    expect(results.flatMap(({ entities }) => entities)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "configuration_key", name: "jwt.expiryMinutes" }),
        expect.objectContaining({ kind: "configuration_key", name: "server.port" }),
        expect.objectContaining({
          kind: "configuration_key",
          name: "security.api-key",
          attributes: expect.objectContaining({ defaultValue: "[REDACTED]" }),
        }),
      ]),
    );
    expect(serialized).not.toContain("do-not-store-this");
    expect(serialized).not.toContain("never-persist-this");
    expect(results.flatMap(({ diagnostics }) => diagnostics)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "YAML_UNSUPPORTED_SEQUENCE" })]),
    );
  });

  it("stores only names from .env.example", async () => {
    const artifact = {
      artifactKind: "configuration" as const,
      content: "JWT_SECRET=never-store-example-value\nAPI_HOST=https://example.test",
      path: ".env.example",
    };
    const result = await new ConfigurationExtractor().extract(artifact, {
      artifacts: [artifact],
      detection: detectProject([artifact]),
      repositoryId: "configuration-fixture",
      revisionId: "configuration-revision",
    });
    expect(result.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "environment_variable", name: "JWT_SECRET" }),
        expect.objectContaining({ kind: "environment_variable", name: "API_HOST" }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("never-store-example-value");
    expect(JSON.stringify(result)).not.toContain("https://example.test");
  });

  it("diagnoses unsupported properties expressions", async () => {
    const artifact = {
      artifactKind: "configuration" as const,
      content: "valid.key=one\nnot a static property expression",
      path: "application.properties",
    };
    const result = await new ConfigurationExtractor().extract(artifact, {
      artifacts: [artifact],
      detection: detectProject([artifact]),
      repositoryId: "configuration-fixture",
      revisionId: "configuration-revision",
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "PROPERTIES_UNSUPPORTED_EXPRESSION" }),
      ]),
    );
  });

  it("links Java, Kotlin, and TypeScript consumers through the pipeline", async () => {
    const artifacts = [
      {
        artifactKind: "configuration" as const,
        content: "service.timeout=30",
        path: "src/main/resources/application.properties",
      },
      {
        artifactKind: "configuration" as const,
        content: "API_HOST=https://localhost",
        path: ".env.example",
      },
      {
        artifactKind: "code" as const,
        content: `class JavaConfig { @Value("\${service.timeout}") String timeout; }`,
        language: "java" as const,
        path: "src/main/java/JavaConfig.java",
      },
      {
        artifactKind: "code" as const,
        content: `class KotlinConfig { fun read() = config.property("service.timeout") }`,
        language: "kotlin" as const,
        path: "src/main/kotlin/KotlinConfig.kt",
      },
      {
        artifactKind: "code" as const,
        content: "export const host = process.env.API_HOST;",
        language: "typescript" as const,
        path: "src/config.ts",
      },
    ];
    const registry = new AdapterRegistry()
      .registerExtractor(new JavaExtractor())
      .registerExtractor(new KotlinExtractor())
      .registerExtractor(new TypeScriptExtractor())
      .registerArtifactExtractor(new ConfigurationExtractor());
    const result = await new ExtractionPipeline(registry).extract({
      artifacts,
      repositoryId: "configuration-link-fixture",
      revisionId: "configuration-link-revision",
    });
    const linkedTargets = new Set(
      result.artifacts
        .flatMap(({ relationships }) => relationships)
        .filter(
          ({ kind, provenance }) =>
            kind === "READS_CONFIG" && provenance.extractor === "configuration-linker",
        )
        .map(({ target }) => target),
    );
    const definitions = result.artifacts
      .flatMap(({ entities }) => entities)
      .filter(({ provenance }) => provenance.extractor === "configuration-manifest");
    expect(
      definitions
        .filter(({ name }) => name === "service.timeout" || name === "API_HOST")
        .every(({ stableKey }) => linkedTargets.has(stableKey)),
    ).toBe(true);
    expect(linkedTargets.size).toBe(2);
  });
});
