import { describe, expect, it } from "vitest";

import { detectProject } from "./project-detector.js";

describe("detectProject", () => {
  it("detects mixed JVM languages, frameworks, source roots, and metadata paths", () => {
    const result = detectProject([
      {
        artifactKind: "build",
        content: `<dependencies>
          <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
          <dependency><groupId>io.vertx</groupId><artifactId>vertx-web</artifactId></dependency>
        </dependencies>`,
        path: "pom.xml",
      },
      {
        artifactKind: "build",
        content: `dependencies { implementation("io.ktor:ktor-server-core:3.2.0") }`,
        path: "server/build.gradle.kts",
      },
      {
        artifactKind: "configuration",
        content: "server.port=8080",
        path: "server/src/main/resources/application.properties",
      },
      {
        artifactKind: "code",
        content: "class App {}",
        language: "java",
        path: "service/src/main/java/com/example/App.java",
      },
      {
        artifactKind: "test",
        content: "class AppTest",
        language: "kotlin",
        path: "service/src/test/kotlin/com/example/AppTest.kt",
      },
    ]);

    expect(result).toEqual({
      configPaths: [
        "pom.xml",
        "server/build.gradle.kts",
        "server/src/main/resources/application.properties",
      ],
      frameworks: ["ktor", "spring-boot", "vertx"],
      languages: ["java", "kotlin"],
      sourceRoots: ["service/src/main/java", "service/src/test/kotlin"],
    });
  });
});
