import { fileURLToPath } from "node:url";

import {
  createCatalogDatabase,
  migrateCatalogToLatest,
  RepositoryCatalog,
  RevisionCatalog,
  type CatalogDatabaseHandle,
} from "@intellirepo/catalog";
import { startPostgresTestContainer, type PostgresTestContainer } from "@intellirepo/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { QuestionTaskCatalog } from "./question-task-catalog.js";

const describeWithPostgres =
  process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../../catalog/migrations", import.meta.url));

describeWithPostgres("QuestionTaskCatalog", () => {
  let container: PostgresTestContainer;
  let handle: CatalogDatabaseHandle;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    handle = createCatalogDatabase(container.connectionUri);
    await migrateCatalogToLatest(handle.database, migrationFolder);
    await new RepositoryCatalog(handle.database).register({
      displayName: "Question task fixture",
      id: "question-task-repository",
      rootPath: "/fixtures/question-task",
    });
    await new RevisionCatalog(handle.database).create({
      commitSha: "commit",
      id: "question-task-revision",
      repositoryId: "question-task-repository",
      worktreeFingerprint: "clean",
    });
  });

  afterAll(async () => {
    await handle.destroy();
    await container.stop();
  });

  it("persists lifecycle state and repository-scoped polling", async () => {
    const catalog = new QuestionTaskCatalog(handle.database);
    await catalog.create({
      id: "task-1",
      question: "Where is AuthService?",
      repositoryId: "question-task-repository",
      revisionId: "question-task-revision",
    });
    expect(await catalog.markRunning("question-task-repository", "task-1")).toBe(true);
    await catalog.fail("question-task-repository", "task-1", "safe failure");

    await expect(catalog.find("question-task-repository", "task-1")).resolves.toMatchObject({
      state: "failed",
    });
    await expect(catalog.find("another-repository", "task-1")).resolves.toBeUndefined();
  });
});
