import { describe, expect, it } from "vitest";

import type { SourceArtifactInput } from "../../interfaces/extraction.js";
import { detectProject } from "../../pipeline/project-detector.js";
import { JavaExtractor } from "./java-extractor.js";

async function extract(artifacts: readonly SourceArtifactInput[]) {
  return new JavaExtractor().extract({
    artifacts,
    detection: detectProject(artifacts),
    repositoryId: "java-fixture",
    revisionId: "revision-java",
  });
}

describe("JavaExtractor", () => {
  it("extracts nested types, members, annotations, inheritance, imports, calls, and tests", async () => {
    const artifacts = [
      {
        artifactKind: "code" as const,
        content: `package com.example;
public interface UserApi { User find(String id); }`,
        language: "java" as const,
        path: "src/main/java/com/example/UserApi.java",
      },
      {
        artifactKind: "code" as const,
        content: `package com.example;
public class UserService implements UserApi {
  private final UserRepository repository;
  public UserService(UserRepository repository) { this.repository = repository; }
  @Override public User find(String id) { return repository.find(id); }
  record User(String id) {}
  enum State { ACTIVE }
}`,
        language: "java" as const,
        path: "src/main/java/com/example/UserService.java",
      },
      {
        artifactKind: "code" as const,
        content: `package com.example;
import com.example.UserService;
class UserServiceTest {
  private UserService service;
  @Test void findsUser() { service.find("42"); }
}`,
        language: "java" as const,
        path: "src/test/java/com/example/UserServiceTest.java",
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
        expect.objectContaining({ kind: "method", name: "find" }),
        expect.objectContaining({
          kind: "class",
          name: "User",
          attributes: expect.objectContaining({ declarationKind: "record" }),
        }),
        expect.objectContaining({
          kind: "class",
          name: "State",
          attributes: expect.objectContaining({ declarationKind: "enum" }),
        }),
        expect.objectContaining({ kind: "annotation", name: "Override" }),
        expect.objectContaining({ kind: "test", name: "findsUser" }),
      ]),
    );
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "IMPLEMENTS" }),
        expect.objectContaining({ kind: "IMPORTS" }),
        expect.objectContaining({ kind: "TESTS" }),
      ]),
    );
    expect(entities.every(({ provenance }) => provenance.range.start.line >= 1)).toBe(true);
  });

  it("keeps overloads distinct and reports ambiguous and external calls", async () => {
    const artifacts = [
      {
        artifactKind: "code" as const,
        content: `package com.example;
class Overloads {
  void send(String value) {}
  void send(String value, int count) {}
  void run() { send("one"); externalCall(); }
}`,
        language: "java" as const,
        path: "src/main/java/com/example/Overloads.java",
      },
      {
        artifactKind: "code" as const,
        content: "package com.example; class Broken { void run( {",
        language: "java" as const,
        path: "src/main/java/com/example/Broken.java",
      },
    ];

    const results = await extract(artifacts);
    const overloads = results
      .flatMap(({ entities }) => entities)
      .filter(({ name }) => name === "send");
    expect(new Set(overloads.map(({ stableKey }) => stableKey)).size).toBe(2);
    expect(results.flatMap(({ relationships }) => relationships)).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "CALLS" })]),
    );
    expect(results.flatMap(({ diagnostics }) => diagnostics).map(({ code }) => code)).toEqual(
      expect.arrayContaining(["JAVA_UNRESOLVED_REFERENCE", "JAVA_SYNTAX_ERROR"]),
    );
  });
});
