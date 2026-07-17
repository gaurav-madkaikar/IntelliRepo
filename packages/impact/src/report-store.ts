import { randomUUID } from "node:crypto";

import type { CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely, Selectable } from "kysely";

import type { ChangeImpactReport } from "./change-summary.js";

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function jsonArray(value: unknown): readonly Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(value)) as readonly Record<string, unknown>[];
}

export class ImpactReportStore {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async save(report: ChangeImpactReport, markdown: string): Promise<string> {
    return this.database.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto("impact_reports")
        .values({
          base_revision_id: report.baseRevisionId,
          created_at: new Date(),
          id: randomUUID(),
          markdown,
          report: jsonObject(report),
          repository_id: report.repositoryId,
          target_revision_id: report.targetRevisionId,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["repository_id", "base_revision_id", "target_revision_id"])
            .doUpdateSet({ created_at: new Date(), markdown, report: jsonObject(report) }),
        )
        .returning("id")
        .executeTakeFirstOrThrow();
      const id = inserted.id;
      await transaction
        .deleteFrom("test_recommendations")
        .where("impact_report_id", "=", id)
        .execute();
      await transaction.deleteFrom("risk_factors").where("impact_report_id", "=", id).execute();
      if (report.tests.length > 0) {
        await transaction
          .insertInto("test_recommendations")
          .values(
            report.tests.map((test) => ({
              confidence_level: test.confidence.level,
              evidence_path: jsonArray(test.evidencePath),
              id: randomUUID(),
              impact_report_id: id,
              reason: test.reason,
              score: test.score,
              test_entity_id: test.testEntity.id,
            })),
          )
          .execute();
      }
      if (report.risk.factors.length > 0) {
        await transaction
          .insertInto("risk_factors")
          .values(
            report.risk.factors.map((factor) => ({
              evidence: { items: factor.evidence },
              explanation: factor.explanation,
              factor: factor.factor,
              id: randomUUID(),
              impact_report_id: id,
              weight: factor.weight,
            })),
          )
          .execute();
      }
      return id;
    });
  }

  public find(
    repositoryId: string,
    baseRevisionId: string,
    targetRevisionId: string,
  ): Promise<Selectable<CatalogDatabase["impact_reports"]> | undefined> {
    return this.database
      .selectFrom("impact_reports")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("base_revision_id", "=", baseRevisionId)
      .where("target_revision_id", "=", targetRevisionId)
      .executeTakeFirst();
  }
}
