import { describe, expect, it } from "vitest";

import { createDefaultAdapterRegistry } from "../../pipeline/default-registry.js";
import { ExtractionPipeline } from "../../pipeline/extraction-pipeline.js";

describe("KtorFrameworkAdapter", () => {
  it("composes nested routes and authentication scopes", async () => {
    const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
      artifacts: [
        {
          artifactKind: "build",
          content: `implementation("io.ktor:ktor-server-core")`,
          path: "build.gradle.kts",
        },
        {
          artifactKind: "code",
          content: `fun userRoutes() {
  routing {
    route("/api") {
      authenticate("jwt") {
        get("/users/{id}") { }
      }
    }
  }
}`,
          language: "kotlin",
          path: "src/main/kotlin/demo/Routes.kt",
        },
      ],
      repositoryId: "ktor-fixture",
      revisionId: "ktor-revision",
    });
    const entities = result.artifacts.flatMap(({ entities }) => entities);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "endpoint", name: "GET /api/users/{id}" }),
        expect.objectContaining({ kind: "middleware", name: "authenticate:jwt" }),
      ]),
    );
  });
});
