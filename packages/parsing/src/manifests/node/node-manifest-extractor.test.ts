import { describe, expect, it } from "vitest";

import { detectProject } from "../../pipeline/project-detector.js";
import { NodeManifestExtractor } from "./node-manifest-extractor.js";

describe("NodeManifestExtractor", () => {
  it("extracts scripts, dependencies, package manager commands, and project references", async () => {
    const packageArtifact = {
      artifactKind: "build" as const,
      content: JSON.stringify({
        dependencies: { express: "5.1.0" },
        devDependencies: { vitest: "4.1.0" },
        name: "demo",
        packageManager: "pnpm@11.7.0",
        scripts: { build: "tsc -b", start: "node dist/main.js", test: "vitest run" },
      }),
      path: "package.json",
    };
    const tsconfigArtifact = {
      artifactKind: "build" as const,
      content: `{
        // JSONC is supported
        "include": ["src"],
        "references": [{ "path": "../contracts" }]
      }`,
      path: "tsconfig.json",
    };
    const artifacts = [packageArtifact, tsconfigArtifact];
    const context = {
      artifacts,
      detection: detectProject(artifacts),
      repositoryId: "node-manifest-fixture",
      revisionId: "node-manifest-revision",
    };
    const extractor = new NodeManifestExtractor();
    const packageResult = await extractor.extract(packageArtifact, context);
    const tsconfigResult = await extractor.extract(tsconfigArtifact, context);

    expect(packageResult.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "dependency", name: "express" }),
        expect.objectContaining({ kind: "dependency", name: "vitest" }),
        expect.objectContaining({
          kind: "build_script",
          attributes: expect.objectContaining({
            commands: ["pnpm run start", "pnpm run build", "pnpm run test"],
          }),
        }),
      ]),
    );
    expect(tsconfigResult.entities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "dependency", name: "../contracts" }),
        expect.objectContaining({ kind: "configuration_key", name: "typescript.include" }),
      ]),
    );
  });

  it("isolates invalid JSON", async () => {
    const artifact = { artifactKind: "build" as const, content: "{ invalid", path: "package.json" };
    const result = await new NodeManifestExtractor().extract(artifact, {
      artifacts: [artifact],
      detection: detectProject([artifact]),
      repositoryId: "node-manifest-fixture",
      revisionId: "node-manifest-revision",
    });
    expect(result.entities).toHaveLength(0);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "PACKAGE_JSON_INVALID" })]),
    );
  });
});
