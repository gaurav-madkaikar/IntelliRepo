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

import { assembleChangeSummary } from "./change-summary.js";
import { ImpactReportStore } from "./report-store.js";

const describeWithDocker = process.env.RUN_INTEGRATION_TESTS === "true" ? describe : describe.skip;
const migrationFolder = fileURLToPath(new URL("../../catalog/migrations", import.meta.url));

describeWithDocker("ImpactReportStore integration", () => {
  let container: PostgresTestContainer;
  let handle: CatalogDatabaseHandle;

  beforeAll(async () => {
    container = await startPostgresTestContainer();
    handle = createCatalogDatabase(container.connectionUri);
    const migration = await migrateCatalogToLatest(handle.database, migrationFolder);
    expect(migration.error).toBeUndefined();
    await new RepositoryCatalog(handle.database).register({
      displayName: "Impact fixture",
      id: "impact-repository",
      rootPath: "/fixtures/impact",
    });
    await new RevisionCatalog(handle.database).create({
      commitSha: "base",
      id: "impact-base",
      repositoryId: "impact-repository",
      worktreeFingerprint: "base",
    });
    await new RevisionCatalog(handle.database).create({
      commitSha: "target",
      id: "impact-target",
      parentRevisionId: "impact-base",
      repositoryId: "impact-repository",
      worktreeFingerprint: "target",
    });
  });

  afterAll(async () => {
    await handle.destroy();
    await container.stop();
  });

  it("replaces an existing revision report and its explanations", async () => {
    const affected = {
      entities: [],
      repositoryId: "impact-repository",
      revisionId: "impact-target",
      truncated: false,
    } as const;
    const diff = {
      baseRevisionId: "impact-base",
      entities: [],
      relationships: [],
      repositoryId: "impact-repository",
      summary: { added: 0, modified: 0, removed: 0 },
      targetRevisionId: "impact-target",
    } as const;
    const report = assembleChangeSummary({
      affected,
      changedFiles: [],
      diff,
      risk: {
        factors: [
          {
            evidence: ["fixture"],
            explanation: "Fixture risk",
            factor: "fixture",
            weight: 1,
          },
        ],
        level: "Low",
        score: 1,
      },
      tests: [],
    });
    const store = new ImpactReportStore(handle.database);

    const firstId = await store.save(report, "first");
    const secondId = await store.save(report, "second");

    expect(secondId).toBe(firstId);
    await expect(
      store.find("impact-repository", "impact-base", "impact-target"),
    ).resolves.toMatchObject({
      id: firstId,
      markdown: "second",
    });
    const factors = await handle.database
      .selectFrom("risk_factors")
      .select("factor")
      .where("impact_report_id", "=", firstId)
      .execute();
    expect(factors).toEqual([{ factor: "fixture" }]);
  });
});
