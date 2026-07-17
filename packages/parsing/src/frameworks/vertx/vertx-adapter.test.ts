import { describe, expect, it } from "vitest";

import { createDefaultAdapterRegistry } from "../../pipeline/default-registry.js";
import { ExtractionPipeline } from "../../pipeline/extraction-pipeline.js";

describe("VertxFrameworkAdapter", () => {
  it("extracts HTTP constraints and ordered handler chains", async () => {
    const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
      artifacts: [
        {
          artifactKind: "build",
          content: `<dependency><groupId>io.vertx</groupId><artifactId>vertx-web</artifactId></dependency>`,
          path: "pom.xml",
        },
        {
          artifactKind: "code",
          content: `class Routes {
  void configure(Router router) {
    router.get("/users/:id").handler(this::authenticate).handler(this::getUser);
  }
  void authenticate(RoutingContext context) {}
  void getUser(RoutingContext context) {}
}`,
          language: "java",
          path: "src/main/java/demo/Routes.java",
        },
      ],
      repositoryId: "vertx-fixture",
      revisionId: "vertx-revision",
    });
    const entities = result.artifacts.flatMap(({ entities }) => entities);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "endpoint", name: "GET /users/{id}" }),
        expect.objectContaining({ kind: "middleware", name: "authenticate" }),
      ]),
    );
  });
});
