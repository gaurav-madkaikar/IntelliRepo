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

import { QuestionCatalog } from "./question-catalog.js";
import type { RepositoryAnswer } from "./qa-model.js";

const describeWithDocker = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../../catalog/migrations", import.meta.url));

describeWithDocker("question catalog integration", () => {
  let container: PostgresTestContainer;
  let handle: CatalogDatabaseHandle;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    handle = createCatalogDatabase(container.connectionUri);
    const migration = await migrateCatalogToLatest(handle.database, migrationFolder);
    expect(migration.error).toBeUndefined();
    await new RepositoryCatalog(handle.database).register({
      displayName: "Question fixture",
      id: "repository-question",
      rootPath: "/fixtures/question",
    });
    await new RevisionCatalog(handle.database).create({
      commitSha: "question-commit",
      id: "revision-question",
      repositoryId: "repository-question",
      worktreeFingerprint: "clean",
    });
  });

  afterAll(async () => {
    await handle.destroy();
    await container.stop();
  });

  it("stores the answer and only its validated references", async () => {
    const answer: RepositoryAnswer = {
      answer: "AuthService handles authentication [E1].",
      citations: [
        {
          confidence: 1,
          endLine: 20,
          evidence: "class declaration",
          id: "E1",
          path: "src/AuthService.ts",
          sourceId: "auth-service",
          sourceKind: "structural",
          startLine: 10,
        },
      ],
      confidence: "high",
      degraded: false,
      degradedReasons: [],
      evidence: {
        edges: [],
        intent: { kind: "entity_lookup", searchTerm: "AuthService", structural: true },
        nodes: [],
        references: [],
        truncated: false,
      },
      inferred: false,
      intent: "entity_lookup",
      question: "Where is AuthService?",
      repositoryId: "repository-question",
      revisionId: "revision-question",
    };
    const identity = await new QuestionCatalog(handle.database).save(answer);

    expect(
      await handle.database
        .selectFrom("questions")
        .select(["answer", "confidence_level"])
        .where("id", "=", identity.questionId)
        .executeTakeFirst(),
    ).toEqual({ answer: answer.answer, confidence_level: "high" });
    expect(
      await handle.database
        .selectFrom("answer_references")
        .select("artifact_path")
        .where("question_id", "=", identity.questionId)
        .execute(),
    ).toEqual([{ artifact_path: "src/AuthService.ts" }]);
  });
});
