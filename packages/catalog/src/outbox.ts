import { randomUUID } from "node:crypto";

import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import type { CatalogDatabase, OutboxEventTable } from "./database-types.js";

export interface OutboxEventInput {
  readonly aggregateId: string;
  readonly availableAt?: Date;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

type CatalogExecutor = Kysely<CatalogDatabase> | Transaction<CatalogDatabase>;

export interface ClaimedOutboxEvent {
  readonly aggregateId: string;
  readonly createdAt: Date;
  readonly eventType: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly publishAttempt: number;
}

function claimedEvent(row: Selectable<OutboxEventTable>): ClaimedOutboxEvent {
  return {
    aggregateId: row.aggregate_id,
    createdAt: row.created_at,
    eventType: row.event_type,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    payload: row.payload,
    publishAttempt: row.publish_attempt,
  };
}

export async function enqueueOutboxEvent(
  executor: CatalogExecutor,
  input: OutboxEventInput,
): Promise<boolean> {
  const result = await executor
    .insertInto("outbox_events")
    .values({
      aggregate_id: input.aggregateId,
      claim_owner: null,
      claimed_at: null,
      event_type: input.eventType,
      id: randomUUID(),
      idempotency_key: input.idempotencyKey,
      last_error: null,
      next_attempt_at: input.availableAt ?? new Date(),
      payload: { ...input.payload },
      published_at: null,
    })
    .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
    .returning("id")
    .executeTakeFirst();

  return result !== undefined;
}

export interface ClaimOutboxOptions {
  readonly claimTimeoutMs?: number;
  readonly eventType?: string;
  readonly limit?: number;
  readonly now?: Date;
  readonly owner: string;
}

export async function claimOutboxEvents(
  database: Kysely<CatalogDatabase>,
  options: ClaimOutboxOptions,
): Promise<readonly ClaimedOutboxEvent[]> {
  const owner = options.owner.trim();
  if (owner.length === 0) throw new Error("Outbox claim owner must not be empty");
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Outbox claim limit must be between 1 and 100");
  }
  const claimTimeoutMs = options.claimTimeoutMs ?? 30_000;
  if (!Number.isInteger(claimTimeoutMs) || claimTimeoutMs < 1) {
    throw new Error("Outbox claim timeout must be positive");
  }
  const now = options.now ?? new Date();
  const staleBefore = new Date(now.getTime() - claimTimeoutMs);

  return database.transaction().execute(async (transaction) => {
    let statement = transaction
      .selectFrom("outbox_events")
      .selectAll()
      .where("published_at", "is", null)
      .where("next_attempt_at", "<=", now)
      .where((expression) =>
        expression.or([
          expression("claim_owner", "is", null),
          expression("claimed_at", "<=", staleBefore),
        ]),
      );
    if (options.eventType !== undefined) {
      statement = statement.where("event_type", "=", options.eventType);
    }
    const rows = await statement
      .orderBy("created_at")
      .limit(limit)
      .forUpdate()
      .skipLocked()
      .execute();
    if (rows.length === 0) return [];

    const ids = rows.map(({ id }) => id);
    await transaction
      .updateTable("outbox_events")
      .set({
        claim_owner: owner,
        claimed_at: now,
        publish_attempt: sql<number>`publish_attempt + 1`,
      })
      .where("id", "in", ids)
      .execute();
    return rows.map((row) => claimedEvent({ ...row, publish_attempt: row.publish_attempt + 1 }));
  });
}

export async function markOutboxEventPublished(
  database: Kysely<CatalogDatabase>,
  id: string,
  owner: string,
  now = new Date(),
): Promise<boolean> {
  const changed = await database
    .updateTable("outbox_events")
    .set({
      claim_owner: null,
      claimed_at: null,
      last_error: null,
      published_at: now,
    })
    .where("id", "=", id)
    .where("claim_owner", "=", owner)
    .where("published_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  return changed !== undefined;
}

export async function releaseOutboxEvent(
  database: Kysely<CatalogDatabase>,
  input: {
    readonly error: Readonly<Record<string, unknown>>;
    readonly id: string;
    readonly owner: string;
    readonly retryAt: Date;
  },
): Promise<boolean> {
  const changed = await database
    .updateTable("outbox_events")
    .set({
      claim_owner: null,
      claimed_at: null,
      last_error: { ...input.error },
      next_attempt_at: input.retryAt,
    })
    .where("id", "=", input.id)
    .where("claim_owner", "=", input.owner)
    .where("published_at", "is", null)
    .returning("id")
    .executeTakeFirst();
  return changed !== undefined;
}
