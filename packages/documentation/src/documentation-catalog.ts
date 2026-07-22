import type { CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely, Selectable } from "kysely";

import type {
  DocumentationAnalysis,
  DocumentationFinding,
  DocumentationGap,
} from "./documentation-model.js";
import type { DocumentationManifest, DocumentationReviewPreview } from "./generation-plan.js";

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

      const activePaths = analysis.pages.map(({ path }) => path);
      let stalePages = transaction
        .deleteFrom("document_pages")
        .where("repository_id", "=", analysis.repositoryId);
      if (activePaths.length > 0) stalePages = stalePages.where("path", "not in", activePaths);
      await stalePages.execute();

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
          id: `${finding.id}:${analysis.revisionId}`,
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
          id: `${gap.id}:${analysis.revisionId}`,
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
        explanation: jsonObject(review.enhancement),
        finding_id: null,
        id: review.id,
        manifest: jsonObject(review.manifest),
        original_checksum: review.originalChecksum,
        proposed_markdown: review.proposedMarkdown,
        repository_id: review.repositoryId,
        request: {},
        revision_id: review.revisionId,
        state: "pending",
        target_path: review.path,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          diff: review.diff,
          explanation: jsonObject(review.enhancement),
          manifest: jsonObject(review.manifest),
          original_checksum: review.originalChecksum,
          proposed_markdown: review.proposedMarkdown,
          state: "pending",
          target_path: review.path,
        }),
      )
      .execute();
  }

  public async findReview(
    repositoryId: string,
    id: string,
  ): Promise<{ readonly preview: DocumentationReviewPreview; readonly state: string } | undefined> {
    const row = await this.database
      .selectFrom("documentation_reviews")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const enhancement = row.explanation as unknown as DocumentationReviewPreview["enhancement"];
    return {
      preview: {
        diff: row.diff,
        enhancement,
        id: row.id,
        manifest: row.manifest as unknown as DocumentationManifest,
        originalChecksum: row.original_checksum,
        path: row.target_path,
        proposedMarkdown: row.proposed_markdown,
        repositoryId: row.repository_id,
        revisionId: row.revision_id,
      },
      state: row.state,
    };
  }

  public async claimReview(repositoryId: string, id: string, revisionId: string): Promise<boolean> {
    const changed = await this.database
      .updateTable("documentation_reviews")
      .set({ state: "applying" })
      .where("repository_id", "=", repositoryId)
      .where("revision_id", "=", revisionId)
      .where("id", "=", id)
      .where("state", "=", "pending")
      .returning("id")
      .executeTakeFirst();
    return changed !== undefined;
  }

  public async releaseReview(repositoryId: string, id: string): Promise<void> {
    await this.database
      .updateTable("documentation_reviews")
      .set({ state: "pending" })
      .where("repository_id", "=", repositoryId)
      .where("id", "=", id)
      .where("state", "=", "applying")
      .execute();
  }

  public async markReviewApplied(repositoryId: string, id: string): Promise<void> {
    await this.database
      .updateTable("documentation_reviews")
      .set({ applied_at: new Date(), state: "applied" })
      .where("repository_id", "=", repositoryId)
      .where("id", "=", id)
      .where("state", "=", "applying")
      .executeTakeFirstOrThrow();
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
