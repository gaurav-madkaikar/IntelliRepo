import { randomUUID } from "node:crypto";

import type { CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely } from "kysely";

import type { RepositoryAnswer } from "./qa-model.js";

export interface StoredQuestionIdentity {
  readonly questionId: string;
  readonly sessionId: string;
}

export class QuestionCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async save(answer: RepositoryAnswer): Promise<StoredQuestionIdentity> {
    return this.database.transaction().execute(async (transaction) => {
      const now = new Date();
      const sessionId = randomUUID();
      const questionId = randomUUID();
      await transaction
        .insertInto("question_sessions")
        .values({
          created_at: now,
          id: sessionId,
          repository_id: answer.repositoryId,
          revision_id: answer.revisionId,
        })
        .execute();
      await transaction
        .insertInto("questions")
        .values({
          answer: answer.answer,
          confidence_level: answer.confidence,
          created_at: now,
          degraded: answer.degraded,
          id: questionId,
          intent: answer.intent,
          question: answer.question,
          session_id: sessionId,
        })
        .execute();
      if (answer.citations.length > 0) {
        await transaction
          .insertInto("answer_references")
          .values(
            answer.citations.map((reference) => ({
              artifact_path: reference.path,
              end_line: reference.endLine ?? null,
              evidence: reference.evidence,
              id: randomUUID(),
              line_start: reference.startLine ?? null,
              question_id: questionId,
              source_id: reference.sourceId,
              source_kind: reference.sourceKind,
            })),
          )
          .execute();
      }
      return { questionId, sessionId };
    });
  }
}
