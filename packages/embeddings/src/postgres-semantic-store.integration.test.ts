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

import { PostgresSemanticChunkStore } from "./postgres-semantic-store.js";
import { SemanticProjector } from "./projector.js";
import { SemanticRetriever } from "./retriever.js";

const describeWithDocker = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../../catalog/migrations", import.meta.url));

describeWithDocker("PostgreSQL pgvector semantic retrieval", () => {
  let container: PostgresTestContainer;
  let handle: CatalogDatabaseHandle;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    handle = createCatalogDatabase(container.connectionUri);
    const migration = await migrateCatalogToLatest(handle.database, migrationFolder);
    expect(migration.error).toBeUndefined();
    for (const suffix of ["a", "b"]) {
      await new RepositoryCatalog(handle.database).register({
        displayName: `Repository ${suffix}`,
        id: `repository-${suffix}`,
        rootPath: `/fixtures/semantic-${suffix}`,
      });
      await new RevisionCatalog(handle.database).create({
        commitSha: `commit-${suffix}`,
        id: `revision-${suffix}`,
        repositoryId: `repository-${suffix}`,
        worktreeFingerprint: "clean",
      });
    }
  });

  afterAll(async () => {
    await handle.destroy();
    await container.stop();
  });

  it("stores redacted chunks and cannot retrieve across repository scope", async () => {
    const store = new PostgresSemanticChunkStore(handle.database);
    const embedder = {
      embed: (input: readonly string[]) =>
        Promise.resolve({ model: "fixture", vectors: input.map(() => [1, 0, 0]) }),
    };
    for (const suffix of ["a", "b"]) {
      await new SemanticProjector(store, embedder).project({
        repositoryId: `repository-${suffix}`,
        revisionId: `revision-${suffix}`,
        sources: [
          {
            artifactKind: "code",
            content: `// Repository ${suffix} authentication workflow with password = secret-${suffix}\nexport function authenticate${suffix.toUpperCase()}() { return validateCredentials(); }`,
            path: `src/auth-${suffix}.ts`,
            sourceId: `auth-${suffix}`,
            sourceKind: "source",
          },
        ],
      });
    }

    const results = await new SemanticRetriever(store, embedder).search(
      "repository-a",
      "authentication",
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.metadata.path).toBe("src/auth-a.ts");
    expect(results[0]?.chunk.content).not.toContain("secret-a");
  });
});
