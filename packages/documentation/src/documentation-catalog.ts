import type { CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely, Selectable } from "kysely";

import type {
  DocumentationAnalysis,
  DocumentationFinding,
  DocumentationGap,
} from "./documentation-model.js";
import type { DocumentationReviewPreview } from "./generation-plan.js";

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function findingEvidence(finding: DocumentationFinding): Record<string, unknown> {
  return {
    ...jsonObject(finding.evidence),
    message: finding.message,
    ...(finding.pageId === undefined ? {} : { pageId: finding.pageId }),
    ...(finding.suggestedText === undefined ? {} : { suggestedText: finding.suggestedText }),
  };
}

function gapEvidence(gap: DocumentationGap): Record<string, unknown> {
  return {
    entityKey: gap.entityKey,
    gapKind: gap.kind,
    message: gap.message,
    suggestedPath: gap.suggestedPath,
  };
}

export class DocumentationCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async saveAnalysis(analysis: DocumentationAnalysis): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .deleteFrom("documentation_findings")
        .where("repository_id", "=", analysis.repositoryId)
        .where("revision_id", "=", analysis.revisionId)
        .execute();

      for (const page of analysis.pages) {
        await transaction
          .insertInto("document_pages")
          .values({
            attributes: { contentHash: page.contentHash },
            id: page.id,
            path: page.path,
            repository_id: analysis.repositoryId,
            revision_id: page.revisionId,
            title: page.title,
          })
          .onConflict((conflict) =>
            conflict.columns(["repository_id", "path"]).doUpdateSet({
              attributes: { contentHash: page.contentHash },
              revision_id: page.revisionId,
              title: page.title,
            }),
          )
          .execute();
        await transaction.deleteFrom("document_sections").where("page_id", "=", page.id).execute();
        if (page.sections.length > 0) {
          await transaction
            .insertInto("document_sections")
            .values(
              page.sections.map((section) => ({
                heading: section.heading,
                id: section.id,
                level: section.level,
                line_end: section.lineEnd,
                line_start: section.lineStart,
                page_id: page.id,
                stable_key: section.stableKey,
              })),
            )
            .execute();
        }
      }
      if (analysis.claims.length > 0) {
        await transaction
          .insertInto("document_claims")
          .values(
            analysis.claims.map((claim) => ({
              claim_kind: claim.kind,
              confidence_score: claim.confidence,
              id: claim.id,
              payload: jsonObject(claim.payload),
              section_id: claim.sectionId,
              source_text: claim.sourceText,
            })),
          )
          .execute();
      }
      const now = new Date();
      const findings = [
        ...analysis.findings.map((finding) => ({
          claim_id: finding.claimId ?? null,
          created_at: now,
          evidence: findingEvidence(finding),
          finding_kind: finding.kind,
          id: finding.id,
          repository_id: analysis.repositoryId,
          revision_id: analysis.revisionId,
          severity: finding.severity,
          status: finding.status,
        })),
        ...analysis.gaps.map((gap) => ({
          claim_id: null,
          created_at: now,
          evidence: gapEvidence(gap),
          finding_kind: "missing_documentation",
          id: gap.id,
          repository_id: analysis.repositoryId,
          revision_id: analysis.revisionId,
          severity: gap.severity,
          status: "confirmed",
        })),
      ];
      if (findings.length > 0) {
        await transaction.insertInto("documentation_findings").values(findings).execute();
      }
      await transaction
        .insertInto("documentation_health")
        .values({
          calculated_at: now,
          explanation: analysis.health.explanation,
          metrics: jsonObject(analysis.health.metrics),
          repository_id: analysis.repositoryId,
          revision_id: analysis.revisionId,
          score: analysis.health.score,
        })
        .onConflict((conflict) =>
          conflict.columns(["repository_id", "revision_id"]).doUpdateSet({
            calculated_at: now,
            explanation: analysis.health.explanation,
            metrics: jsonObject(analysis.health.metrics),
            score: analysis.health.score,
          }),
        )
        .execute();
    });
  }

  public async saveReview(review: DocumentationReviewPreview): Promise<void> {
    await this.database
      .insertInto("documentation_reviews")
      .values({
        applied_at: null,
        created_at: new Date(),
        diff: review.diff,
        finding_id: null,
        id: review.id,
        proposed_markdown: review.proposedMarkdown,
        repository_id: review.repositoryId,
        revision_id: review.revisionId,
        state: "pending",
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          diff: review.diff,
          proposed_markdown: review.proposedMarkdown,
          state: "pending",
        }),
      )
      .execute();
  }

  public findHealth(
    repositoryId: string,
    revisionId: string,
  ): Promise<Selectable<CatalogDatabase["documentation_health"]> | undefined> {
    return this.database
      .selectFrom("documentation_health")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("revision_id", "=", revisionId)
      .executeTakeFirst();
  }
}
