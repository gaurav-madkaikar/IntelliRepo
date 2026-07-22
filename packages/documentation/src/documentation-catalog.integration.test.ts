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

import { DocumentationAnalyzer } from "./documentation-analyzer.js";
import { DocumentationCatalog } from "./documentation-catalog.js";
import { DocumentationGenerator } from "./generation-plan.js";

const describeWithDocker = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../../catalog/migrations", import.meta.url));

describeWithDocker("documentation catalog integration", () => {
  let container: PostgresTestContainer;
  let handle: CatalogDatabaseHandle;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    handle = createCatalogDatabase(container.connectionUri);
    const migration = await migrateCatalogToLatest(handle.database, migrationFolder);
    expect(migration.error).toBeUndefined();
    await new RepositoryCatalog(handle.database).register({
      displayName: "Documentation fixture",
      id: "repository-documentation",
      rootPath: "/fixtures/documentation",
    });
    await new RevisionCatalog(handle.database).create({
      commitSha: "documentation-commit",
      id: "revision-documentation",
      repositoryId: "repository-documentation",
      worktreeFingerprint: "clean",
    });
  });

  afterAll(async () => {
    await handle.destroy();
    await container.stop();
  });

  it("replaces analysis state idempotently and stores review previews", async () => {
    const snapshot = {
      entities: [],
      relationships: [],
      repositoryId: "repository-documentation",
      revisionId: "revision-documentation",
    } as const;
    const analysis = new DocumentationAnalyzer().analyze({
      documents: [{ content: "# Overview\n\nCurrent documentation.", path: "docs/overview.md" }],
      snapshot,
    });
    const catalog = new DocumentationCatalog(handle.database);
    await catalog.saveAnalysis(analysis);
    await catalog.saveAnalysis(analysis);
    const review = await new DocumentationGenerator().prepare({
      kind: "architecture",
      snapshot,
      title: "Architecture",
    });
    await catalog.saveReview(review);
    await catalog.saveReview(review);

    const reloaded = await catalog.findReview(snapshot.repositoryId, review.id);
    expect(reloaded).toMatchObject({
      preview: {
        manifest: review.manifest,
        originalChecksum: review.originalChecksum,
        path: review.path,
      },
      state: "pending",
    });
    expect(await catalog.claimReview(snapshot.repositoryId, review.id, snapshot.revisionId)).toBe(
      true,
    );
    expect(await catalog.claimReview(snapshot.repositoryId, review.id, snapshot.revisionId)).toBe(
      false,
    );
    await catalog.markReviewApplied(snapshot.repositoryId, review.id);

    expect(await catalog.findHealth(snapshot.repositoryId, snapshot.revisionId)).toMatchObject({
      score: 100,
    });
    expect(await handle.database.selectFrom("document_pages").select("id").execute()).toHaveLength(
      1,
    );
    expect(
      await handle.database.selectFrom("documentation_reviews").select("id").execute(),
    ).toHaveLength(1);
  });
});
