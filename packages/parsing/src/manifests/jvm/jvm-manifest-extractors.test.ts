import { describe, expect, it } from "vitest";

import { detectProject } from "../../pipeline/project-detector.js";
import { GradleExtractor } from "./gradle-extractor.js";
import { MavenExtractor } from "./maven-extractor.js";

describe("JVM manifest extractors", () => {
  it("extracts Maven modules, dependencies, plugins, and wrapper commands", async () => {
    const artifact = {
      artifactKind: "build" as const,
      content: `<project>
  <groupId>com.example</groupId><artifactId>service</artifactId><version>1.0.0</version>
  <modules><module>api</module></modules>
  <dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId><version>3.5.0</version></dependency></dependencies>
  <build><plugins><plugin><groupId>org.springframework.boot</groupId><artifactId>spring-boot-maven-plugin</artifactId></plugin></plugins></build>
</project>`,
      path: "pom.xml",
    };
    const artifacts = [artifact, { artifactKind: "build" as const, content: "", path: "mvnw" }];
    const result = await new MavenExtractor().extract(artifact, {
      artifacts,
      detection: detectProject(artifacts),
      repositoryId: "manifest-fixture",
      revisionId: "manifest-revision",
    });

    expect(result.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "module", name: "service" }),
        expect.objectContaining({ kind: "module", name: "api" }),
        expect.objectContaining({ kind: "dependency", name: "spring-boot-starter-web" }),
        expect.objectContaining({ kind: "dependency", name: "spring-boot-maven-plugin" }),
        expect.objectContaining({
          kind: "build_script",
          attributes: expect.objectContaining({
            commands: expect.arrayContaining([
              "./mvnw clean package",
              "./mvnw test",
              "./mvnw spring-boot:run",
            ]),
          }),
        }),
      ]),
    );
    expect(result.relationships).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "DEPENDS_ON" })]),
    );
  });

  it("extracts Gradle Groovy and Kotlin DSL facts and diagnoses dynamic dependencies", async () => {
    const extractor = new GradleExtractor();
    const artifacts = [
      { artifactKind: "build" as const, content: "", path: "gradlew" },
      {
        artifactKind: "build" as const,
        content: `plugins { id("org.springframework.boot") version "3.5.0" }
dependencies {
  implementation("io.ktor:ktor-server-core:3.2.0")
  testImplementation(libs.junit)
}`,
        path: "build.gradle.kts",
      },
      {
        artifactKind: "build" as const,
        content: `rootProject.name = 'demo'
include ':api'`,
        path: "settings.gradle",
      },
    ];
    const result = await extractor.extract(artifacts[1]!, {
      artifacts,
      detection: detectProject(artifacts),
      repositoryId: "manifest-fixture",
      revisionId: "manifest-revision",
    });

    expect(result.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "dependency", name: "ktor-server-core" }),
        expect.objectContaining({ kind: "dependency", name: "org.springframework.boot" }),
        expect.objectContaining({
          kind: "build_script",
          attributes: expect.objectContaining({
            commands: expect.arrayContaining([
              "./gradlew build",
              "./gradlew test",
              "./gradlew bootRun",
            ]),
          }),
        }),
      ]),
    );
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "GRADLE_UNSUPPORTED_EXPRESSION" })]),
    );
  });

  it("diagnoses an incomplete Maven project without guessing dependencies", async () => {
    const artifact = {
      artifactKind: "build" as const,
      content: "<project><dependencies><dependency>",
      path: "pom.xml",
    };
    const result = await new MavenExtractor().extract(artifact, {
      artifacts: [artifact],
      detection: detectProject([artifact]),
      repositoryId: "manifest-fixture",
      revisionId: "manifest-revision",
    });
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "MAVEN_INVALID_XML" })]),
    );
    expect(result.entities.filter(({ kind }) => kind === "dependency")).toHaveLength(0);
  });
});
