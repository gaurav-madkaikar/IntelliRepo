import type { CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely, Selectable } from "kysely";

import type { RepositoryAnswer } from "./qa-model.js";

function jsonObject(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export type QuestionTaskRecord = Selectable<CatalogDatabase["question_tasks"]>;

export class QuestionTaskCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async create(input: {
    readonly id: string;
    readonly question: string;
    readonly repositoryId: string;
    readonly revisionId: string;
  }): Promise<QuestionTaskRecord> {
    const now = new Date();
    return this.database
      .insertInto("question_tasks")
      .values({
        created_at: now,
        error: null,
        id: input.id,
        question: input.question,
        repository_id: input.repositoryId,
        result: null,
        revision_id: input.revisionId,
        state: "queued",
        updated_at: now,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  public find(repositoryId: string, id: string): Promise<QuestionTaskRecord | undefined> {
    return this.database
      .selectFrom("question_tasks")
      .selectAll()
      .where("repository_id", "=", repositoryId)
      .where("id", "=", id)
      .executeTakeFirst();
  }

  public async markRunning(repositoryId: string, id: string): Promise<boolean> {
    const changed = await this.database
      .updateTable("question_tasks")
      .set({ state: "running", updated_at: new Date() })
      .where("repository_id", "=", repositoryId)
      .where("id", "=", id)
      .where("state", "=", "queued")
      .returning("id")
      .executeTakeFirst();
    return changed !== undefined;
  }

  public async succeed(repositoryId: string, id: string, answer: RepositoryAnswer): Promise<void> {
    await this.database
      .updateTable("question_tasks")
      .set({ error: null, result: jsonObject(answer), state: "succeeded", updated_at: new Date() })
      .where("repository_id", "=", repositoryId)
      .where("id", "=", id)
      .where("state", "=", "running")
      .executeTakeFirstOrThrow();
  }

  public async fail(repositoryId: string, id: string, message: string): Promise<void> {
    await this.database
      .updateTable("question_tasks")
      .set({ error: { message }, state: "failed", updated_at: new Date() })
      .where("repository_id", "=", repositoryId)
      .where("id", "=", id)
      .where("state", "in", ["queued", "running"])
      .executeTakeFirstOrThrow();
  }

  public async failAbandoned(message: string): Promise<number> {
    const changed = await this.database
      .updateTable("question_tasks")
      .set({ error: { message }, state: "failed", updated_at: new Date() })
      .where("state", "=", "running")
      .returning("id")
      .execute();
    return changed.length;
  }
}
