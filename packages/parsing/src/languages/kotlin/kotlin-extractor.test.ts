import { describe, expect, it } from "vitest";

import type { SourceArtifactInput } from "../../interfaces/extraction.js";
import { detectProject } from "../../pipeline/project-detector.js";
import { JavaExtractor } from "../java/java-extractor.js";
import { KotlinExtractor } from "./kotlin-extractor.js";

async function extract(artifacts: readonly SourceArtifactInput[]) {
  return new KotlinExtractor().extract({
    artifacts,
    detection: detectProject(artifacts),
    repositoryId: "kotlin-fixture",
    revisionId: "revision-kotlin",
  });
}

describe("KotlinExtractor", () => {
  it("extracts classes, objects, constructors, properties, extensions, annotations, calls, and tests", async () => {
    const artifacts = [
      {
        artifactKind: "code" as const,
        content: `package com.example
interface UserApi { fun find(id: String): User }
class UserService(private val repository: UserRepository) : UserApi {
  companion object { fun create(repository: UserRepository) = UserService(repository) }
  @Deprecated fun find(id: String): User = repository.find(id)
}
fun String.slug(): String = trim()
object Registry { fun size(): Int = 1 }`,
        language: "kotlin" as const,
        path: "src/main/kotlin/com/example/UserService.kt",
      },
      {
        artifactKind: "test" as const,
        content: `package com.example
class UserServiceTest(private val service: UserService) {
  @Test fun findsUser() { service.find("42") }
}`,
        language: "kotlin" as const,
        path: "src/test/kotlin/com/example/UserServiceTest.kt",
      },
    ];

    const results = await extract(artifacts);
    const entities = results.flatMap(({ entities }) => entities);
    const relationships = results.flatMap(({ relationships }) => relationships);

    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "interface", name: "UserApi" }),
        expect.objectContaining({ kind: "class", name: "UserService" }),
        expect.objectContaining({ kind: "constructor", name: "UserService" }),
        expect.objectContaining({ kind: "field", name: "repository" }),
        expect.objectContaining({ kind: "object", name: "Companion" }),
        expect.objectContaining({ kind: "object", name: "Registry" }),
        expect.objectContaining({ kind: "function", name: "slug" }),
        expect.objectContaining({ kind: "annotation", name: "Deprecated" }),
        expect.objectContaining({ kind: "test", name: "findsUser" }),
      ]),
    );
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "IMPLEMENTS" }),
        expect.objectContaining({ kind: "TESTS" }),
      ]),
    );
  });

  it("keeps ambiguous receivers unresolved and recovers malformed files", async () => {
    const artifacts = [
      {
        artifactKind: "code" as const,
        content: "package one\nfun work(value: String) = value",
        language: "kotlin" as const,
        path: "src/main/kotlin/one/Work.kt",
      },
      {
        artifactKind: "code" as const,
        content: "package two\nfun work(value: String) = value",
        language: "kotlin" as const,
        path: "src/main/kotlin/two/Work.kt",
      },
      {
        artifactKind: "code" as const,
        content: 'package consumer\nimport one.*\nimport two.*\nfun run() = work("x")',
        language: "kotlin" as const,
        path: "src/main/kotlin/consumer/Run.kt",
      },
      {
        artifactKind: "code" as const,
        content: "package consumer\nclass Broken(",
        language: "kotlin" as const,
        path: "src/main/kotlin/consumer/Broken.kt",
      },
    ];

    const results = await extract(artifacts);
    const diagnostics = results.flatMap(({ diagnostics }) => diagnostics);
    expect(diagnostics.map(({ code }) => code)).toEqual(
      expect.arrayContaining(["KOTLIN_AMBIGUOUS_REFERENCE", "KOTLIN_SYNTAX_ERROR"]),
    );
    expect(
      results.flatMap(({ relationships }) => relationships).filter(({ kind }) => kind === "CALLS"),
    ).toHaveLength(0);
  });

  it("uses different stable identities for equivalent Java and Kotlin names", async () => {
    const javaArtifacts = [
      {
        artifactKind: "code" as const,
        content: "package mixed; class Shared {}",
        language: "java" as const,
        path: "src/main/java/mixed/Shared.java",
      },
    ];
    const kotlinArtifacts = [
      {
        artifactKind: "code" as const,
        content: "package mixed\nclass Shared",
        language: "kotlin" as const,
        path: "src/main/kotlin/mixed/Shared.kt",
      },
    ];
    const java = await new JavaExtractor().extract({
      artifacts: javaArtifacts,
      detection: detectProject(javaArtifacts),
      repositoryId: "mixed-fixture",
      revisionId: "mixed-revision",
    });
    const kotlin = await new KotlinExtractor().extract({
      artifacts: kotlinArtifacts,
      detection: detectProject(kotlinArtifacts),
      repositoryId: "mixed-fixture",
      revisionId: "mixed-revision",
    });
    const javaKey = java
      .flatMap(({ entities }) => entities)
      .find(({ name }) => name === "Shared")?.stableKey;
    const kotlinKey = kotlin
      .flatMap(({ entities }) => entities)
      .find(({ name }) => name === "Shared")?.stableKey;
    expect(javaKey).toBeDefined();
    expect(kotlinKey).toBeDefined();
    expect(javaKey).not.toBe(kotlinKey);
  });
});
