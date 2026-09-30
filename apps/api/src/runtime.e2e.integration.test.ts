import { execFile as execFileCallback } from "node:child_process";
import { promises as fileSystem } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { loadApplicationConfig } from "@intellirepo/contracts";
import { FilePolicy, GitChangeDetector } from "@intellirepo/repository";
import { startPostgresTestContainer, type PostgresTestContainer } from "@intellirepo/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DatabaseResource, PostgresProductFacade } from "./product/product-facade.js";

const execFile = promisify(execFileCallback);
const describeWithPostgres =
  process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

describeWithPostgres("inline product runtime acceptance", () => {
  let container: PostgresTestContainer;
  let repositoryRoot: string;
  let resource: DatabaseResource;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    repositoryRoot = await fileSystem.mkdtemp(join(tmpdir(), "intellirepo-api-e2e-"));
    await fileSystem.mkdir(join(repositoryRoot, "src"));
    await fileSystem.mkdir(join(repositoryRoot, "docs"));
    await fileSystem.writeFile(
      join(repositoryRoot, "package.json"),
      JSON.stringify({ dependencies: { express: "latest" }, name: "api-e2e" }),
    );
    await fileSystem.writeFile(
      join(repositoryRoot, "src", "app.ts"),
      [
        "import express from 'express';",
        "const app = express();",
        "// Public health route with deterministic response behavior.",
        "app.get('/health', function health(_request, response) { response.json({ ok: true }); });",
        "export { app };",
      ].join("\n"),
    );
    await fileSystem.writeFile(
      join(repositoryRoot, "docs", "overview.md"),
      "# Service overview\n\nThe health endpoint reports whether the local service is available.\n",
    );
    await execFile("git", ["init", "-b", "main", repositoryRoot]);
    await execFile("git", ["-C", repositoryRoot, "add", "."]);
    await execFile("git", [
      "-C",
      repositoryRoot,
      "-c",
      "user.name=IntelliRepo E2E",
      "-c",
      "user.email=e2e@intellirepo.local",
      "commit",
      "-m",
      "fixture",
    ]);
    resource = await DatabaseResource.create(container.connectionUri);
  }, 120_000);

  afterAll(async () => {
    if (resource !== undefined) await resource.onModuleDestroy();
    if (container !== undefined) await container.stop();
    if (repositoryRoot !== undefined) {
      await fileSystem.rm(repositoryRoot, { force: true, recursive: true });
    }
  });

  it("indexes, analyzes, answers, and applies a reloaded review without Ollama or Redis", async () => {
    const config = loadApplicationConfig(
      {
        DATABASE_URL: container.connectionUri,
        INDEXING_MODE: "inline",
        OLLAMA_ENABLED: "false",
        REDIS_URL: "",
        REPOSITORY_ALLOWED_ROOTS: repositoryRoot,
      },
      repositoryRoot,
    );
    const facade = new PostgresProductFacade(resource, config);
    const registered = (await facade.registerRepository({ rootPath: repositoryRoot })) as {
      readonly id: string;
    };
    const detector = new GitChangeDetector(new FilePolicy(config.maxFileBytes));
    const target = {
      commitSha: await detector.headRevision(repositoryRoot),
      worktreeFingerprint: await detector.fingerprintWorkingTree(repositoryRoot),
    };
    let scan = await facade.triggerScan(registered.id, target);
    for (
      let attempt = 0;
      attempt < 200 && scan.state !== "COMPLETED" && scan.state !== "FAILED";
      attempt += 1
    ) {
      await wait(25);
      scan = await facade.scan(registered.id, scan.id);
    }
    expect(scan.state, JSON.stringify(scan.error)).toBe("COMPLETED");
    expect(scan.degradedReasons.join(" ")).toContain("Embedding adapter unavailable");
    const overview = await facade.overview(registered.id);
    expect(overview).toMatchObject({
      capabilities: {
        analysis: { state: "current" },
        canonical: { state: "current" },
        semantic: { state: "disabled" },
        worker: { dispatchMode: "inline" },
      },
      selectedTraversalAdapter: "postgresql",
    });

    let question = await facade.submitQuestion(registered.id, {
      question: "Where is the health endpoint?",
    });
    for (
      let attempt = 0;
      attempt < 200 && (question.state === "queued" || question.state === "running");
      attempt += 1
    ) {
      await wait(25);
      question = await facade.question(registered.id, question.id);
    }
    expect(question.state).toBe("succeeded");
    expect(question.result).toMatchObject({ degraded: true, repositoryId: registered.id });

    const preview = await facade.previewDocumentation(registered.id, {
      kind: "architecture",
      targetPath: "docs/intellirepo/architecture.md",
      title: "Architecture",
    });
    const recreatedFacade = new PostgresProductFacade(resource, config);
    await expect(recreatedFacade.applyDocumentation(registered.id, preview.id)).resolves.toEqual({
      applied: true,
    });
    await expect(
      fileSystem.readFile(join(repositoryRoot, "docs", "intellirepo", "architecture.md"), "utf8"),
    ).resolves.toContain("Generated by IntelliRepo");
    await expect(recreatedFacade.applyDocumentation(registered.id, preview.id)).rejects.toThrow(
      "applied",
    );
  }, 120_000);
});
