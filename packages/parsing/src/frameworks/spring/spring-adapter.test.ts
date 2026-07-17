import { describe, expect, it } from "vitest";

import { ExtractionPipeline } from "../../pipeline/extraction-pipeline.js";
import { createDefaultAdapterRegistry } from "../../pipeline/default-registry.js";

describe("SpringFrameworkAdapter", () => {
  it("composes controller and method paths and captures security and DTO facts", async () => {
    const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
      artifacts: [
        {
          artifactKind: "build",
          content: "<dependency><artifactId>spring-boot-starter-web</artifactId></dependency>",
          path: "pom.xml",
        },
        {
          artifactKind: "code",
          content: `package demo;
@RequestMapping("/api/users")
@RestController
public class UserController {
  @GetMapping("/{id}")
  @PreAuthorize("hasRole('USER')")
  public UserResponse getUser(String id) { return null; }
  @PostMapping
  public UserResponse create(@RequestBody CreateUserRequest request) { return null; }
}`,
          language: "java",
          path: "src/main/java/demo/UserController.java",
        },
      ],
      repositoryId: "spring-fixture",
      revisionId: "spring-revision",
    });

    const entities = result.artifacts.flatMap(({ entities }) => entities);
    const relationships = result.artifacts.flatMap(({ relationships }) => relationships);
    expect(entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "endpoint",
          name: "GET /api/users/{id}",
          attributes: expect.objectContaining({ responseType: "UserResponse" }),
        }),
        expect.objectContaining({
          kind: "endpoint",
          name: "POST /api/users",
          attributes: expect.objectContaining({ requestType: "CreateUserRequest" }),
        }),
        expect.objectContaining({ kind: "middleware", name: "PreAuthorize" }),
      ]),
    );
    expect(relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "HANDLES" }),
        expect.objectContaining({ kind: "USES_MIDDLEWARE" }),
      ]),
    );
  });

  it("expands explicit RequestMapping methods and diagnoses dynamic routes", async () => {
    const result = await new ExtractionPipeline(createDefaultAdapterRegistry()).extract({
      artifacts: [
        {
          artifactKind: "build",
          content: "<dependency><artifactId>spring-boot-starter-web</artifactId></dependency>",
          path: "pom.xml",
        },
        {
          artifactKind: "code",
          content: `@RestController
class SearchController {
  @RequestMapping(path = "/search", method = {RequestMethod.GET, RequestMethod.POST})
  String search() { return ""; }
  @GetMapping(ROUTE_PATH)
  String dynamic() { return ""; }
}`,
          language: "java",
          path: "src/main/java/demo/SearchController.java",
        },
      ],
      repositoryId: "spring-multiple",
      revisionId: "spring-multiple-revision",
    });

    const endpointNames = result.artifacts
      .flatMap(({ entities }) => entities)
      .filter(({ kind }) => kind === "endpoint")
      .map(({ name }) => name);
    expect(endpointNames).toEqual(expect.arrayContaining(["GET /search", "POST /search"]));
    expect(result.diagnostics.map(({ code }) => code)).toContain("SPRING_DYNAMIC_ROUTE");
  });
});
