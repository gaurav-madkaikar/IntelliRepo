import { randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";

import type { CatalogDatabase } from "./database-types.js";

export interface OutboxEventInput {
  readonly aggregateId: string;
  readonly eventType: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

type CatalogExecutor = Kysely<CatalogDatabase> | Transaction<CatalogDatabase>;

export async function enqueueOutboxEvent(
  executor: CatalogExecutor,
  input: OutboxEventInput,
): Promise<boolean> {
  const result = await executor
    .insertInto("outbox_events")
    .values({
      aggregate_id: input.aggregateId,
      event_type: input.eventType,
      id: randomUUID(),
      idempotency_key: input.idempotencyKey,
      payload: { ...input.payload },
      published_at: null,
    })
    .onConflict((conflict) => conflict.column("idempotency_key").doNothing())
    .returning("id")
    .executeTakeFirst();

  return result !== undefined;
}
