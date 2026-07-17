import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import type { SourceArtifactInput } from "../interfaces/extraction.js";
import { createDefaultAdapterRegistry } from "../pipeline/default-registry.js";
import { ExtractionPipeline } from "../pipeline/extraction-pipeline.js";

const examples = new URL("../../../../examples/", import.meta.url);

async function artifact(
  repository: string,
  path: string,
  artifactKind: SourceArtifactInput["artifactKind"],
  language?: SourceArtifactInput["language"],
): Promise<SourceArtifactInput> {
  return {
    artifactKind,
    content: await readFile(new URL(`${repository}/${path}`, examples), "utf8"),
    ...(language === undefined ? {} : { language }),
    path,
  };
}

async function endpointNames(
  repository: string,
  artifacts: readonly SourceArtifactInput[],
): Promise<readonly string[]> {
  const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
    artifacts,
    repositoryId: repository,
    revisionId: `${repository}-revision`,
  });
  return result.artifacts
    .flatMap(({ entities }) => entities)
    .filter(({ kind }) => kind === "endpoint")
    .map(({ name }) => name)
    .sort();
}

describe("framework adapter suite", () => {
  it("meets the reviewed endpoint precision and recall target for every example", async () => {
    const fixtures = [
      {
        actual: endpointNames("spring-auth", [
          await artifact("spring-auth", "pom.xml", "build"),
          await artifact("spring-auth", "src/main/java/demo/AuthController.java", "code", "java"),
        ]),
        expected: ["POST /api/auth/login"],
        name: "spring-auth",
      },
      {
        actual: endpointNames("ktor-orders", [
          await artifact("ktor-orders", "build.gradle.kts", "build"),
          await artifact("ktor-orders", "src/main/kotlin/demo/OrderRoutes.kt", "code", "kotlin"),
        ]),
        expected: ["GET /api/orders/{id}"],
        name: "ktor-orders",
      },
      {
        actual: endpointNames("vertx-notifications", [
          await artifact("vertx-notifications", "pom.xml", "build"),
          await artifact(
            "vertx-notifications",
            "src/main/java/demo/NotificationRoutes.java",
            "code",
            "java",
          ),
        ]),
        expected: ["POST /notifications"],
        name: "vertx-notifications",
      },
      {
        actual: endpointNames("nest-payments", [
          await artifact("nest-payments", "package.json", "build"),
          await artifact("nest-payments", "src/payment.controller.ts", "code", "typescript"),
        ]),
        expected: ["GET /payments/{id}"],
        name: "nest-payments",
      },
      {
        actual: endpointNames("express-users", [
          await artifact("express-users", "package.json", "build"),
          await artifact("express-users", "src/routes.ts", "code", "typescript"),
        ]),
        expected: ["GET /api/users/{id}"],
        name: "express-users",
      },
    ];

    for (const fixture of fixtures) {
      const actual = await fixture.actual;
      const expected = new Set(fixture.expected);
      const matches = actual.filter((endpoint) => expected.has(endpoint)).length;
      const precision = actual.length === 0 ? 0 : matches / actual.length;
      const recall = matches / fixture.expected.length;
      expect({ actual, precision, recall }, fixture.name).toEqual({
        actual: fixture.expected,
        precision: 1,
        recall: 1,
      });
    }
  });
});
