import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { SourceArtifactInput } from "../../interfaces/extraction.js";
import { detectProject } from "../../pipeline/project-detector.js";
import { TypeScriptExtractor } from "./typescript-extractor.js";

const fixtureRoot = new URL("./fixtures/semantic/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, fixtureRoot), "utf8");
}

async function extract(artifacts: readonly SourceArtifactInput[]) {
  return new TypeScriptExtractor().extract({
    artifacts,
    detection: detectProject(artifacts),
    repositoryId: "repository-typescript",
    revisionId: "revision-typescript",
  });
}

describe("TypeScriptExtractor", () => {
  it("matches semantic golden facts for aliases, re-exports, overloads, async calls, tests, and env", async () => {
    const artifacts = [
      {
        artifactKind: "code" as const,
        content: await fixture("service.ts.txt"),
        language: "typescript" as const,
        path: "src/service.ts",
      },
      {
        artifactKind: "code" as const,
        content: await fixture("consumer.ts.txt"),
        language: "typescript" as const,
        path: "src/consumer.ts",
      },
      {
        artifactKind: "test" as const,
        content: await fixture("service.test.ts.txt"),
        language: "typescript" as const,
        path: "src/service.test.ts",
      },
    ];
    const expected = JSON.parse(await fixture("expected.json")) as {
      entityKinds: string[];
      relationshipKinds: string[];
      requiredNames: string[];
    };

    const results = await extract(artifacts);
    const entities = results.flatMap(({ entities: facts }) => facts);
    const relationships = results.flatMap(({ relationships: facts }) => facts);
    const entityKinds = [...new Set(entities.map(({ kind }) => kind))].sort();
    const relationshipKinds = [...new Set(relationships.map(({ kind }) => kind))].sort();

    expect(results.every(({ mode }) => mode === "semantic")).toBe(true);
    expect(entityKinds).toEqual(expected.entityKinds);
    expect(relationshipKinds).toEqual(expected.relationshipKinds);
    const entityNames = new Set(entities.map(({ name }) => name));
    expect(expected.requiredNames.every((name) => entityNames.has(name))).toBe(true);
    for (const fact of [...entities, ...relationships]) {
      expect(fact.provenance.range.start.line).toBeGreaterThan(0);
      expect(fact.provenance.range.end.line).toBeGreaterThanOrEqual(
        fact.provenance.range.start.line,
      );
    }
    expect(relationships.filter(({ kind }) => kind === "CALLS" || kind === "TESTS")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: expect.objectContaining({
            confidence: expect.objectContaining({ level: "inferred" }),
          }),
        }),
      ]),
    );
  });

  it("uses Tree-sitter for invalid project configuration and keeps ambiguous calls tentative", async () => {
    const artifacts = [
      {
        artifactKind: "build" as const,
        content: '{"compilerOptions":{"module":"not-a-real-module"}}',
        path: "tsconfig.json",
      },
      {
        artifactKind: "code" as const,
        content: "export function run() { return 1; }",
        language: "typescript" as const,
        path: "src/a.ts",
      },
      {
        artifactKind: "code" as const,
        content: "export function run() { return 2; }",
        language: "typescript" as const,
        path: "src/b.ts",
      },
      {
        artifactKind: "code" as const,
        content: "export function main() { return run(); }",
        language: "typescript" as const,
        path: "src/main.ts",
      },
    ];

    const results = await extract(artifacts);
    const calls = results.flatMap(({ relationships }) =>
      relationships.filter(({ kind }) => kind === "CALLS"),
    );

    expect(results).toHaveLength(3);
    expect(results.every(({ mode }) => mode === "syntax-fallback")).toBe(true);
    expect(results.flatMap(({ diagnostics }) => diagnostics)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TS_PROJECT_CONFIG_FALLBACK" }),
        expect.objectContaining({ code: "TS_AMBIGUOUS_CALL" }),
      ]),
    );
    expect(calls.every(({ provenance }) => provenance.confidence.level === "tentative")).toBe(true);
  });

  it("retains healthy artifact facts when another source file has incomplete syntax", async () => {
    const results = await extract([
      {
        artifactKind: "code",
        content: "export function healthy() { return 1; }",
        language: "typescript",
        path: "src/healthy.ts",
      },
      {
        artifactKind: "code",
        content: "export function broken( {",
        language: "typescript",
        path: "src/broken.ts",
      },
    ]);

    expect(results.find(({ artifactPath }) => artifactPath === "src/healthy.ts")?.entities).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "healthy" })]),
    );
    expect(
      results.find(({ artifactPath }) => artifactPath === "src/broken.ts")?.diagnostics,
    ).not.toHaveLength(0);
  });
});
