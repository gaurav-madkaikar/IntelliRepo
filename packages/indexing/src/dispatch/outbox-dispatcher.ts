import {
  claimOutboxEvents,
  markOutboxEventPublished,
  releaseOutboxEvent,
  ScanJobCatalog,
  type CatalogDatabase,
  type ClaimedOutboxEvent,
} from "@intellirepo/catalog";
import type { Kysely } from "kysely";

import type { DispatchScanInput, ScanDispatcher } from "./scan-dispatcher.js";

function dispatchInput(event: ClaimedOutboxEvent): DispatchScanInput {
  const { repositoryId, revisionId, scanJobId } = event.payload;
  if (
    typeof repositoryId !== "string" ||
    typeof revisionId !== "string" ||
    typeof scanJobId !== "string" ||
    repositoryId.length === 0 ||
    revisionId.length === 0 ||
    scanJobId.length === 0
  ) {
    throw new Error(`Outbox event ${event.id} has an invalid scan payload`);
  }
  return { repositoryId, revisionId, scanJobId };
}

export interface OutboxDispatcherOptions {
  readonly claimTimeoutMs?: number;
  readonly limit?: number;
  readonly owner: string;
  readonly retryBackoffMs: number;
}

export interface OutboxPumpResult {
  readonly attempted: number;
  readonly failed: number;
  readonly published: number;
}

export class OutboxDispatcher {
  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    private readonly dispatcher: ScanDispatcher,
    private readonly options: OutboxDispatcherOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!Number.isInteger(options.retryBackoffMs) || options.retryBackoffMs < 1) {
      throw new Error("Outbox retry backoff must be a positive integer");
    }
  }

  public async pump(): Promise<OutboxPumpResult> {
    const now = this.clock();
    const events = await claimOutboxEvents(this.database, {
      ...(this.options.claimTimeoutMs === undefined
        ? {}
        : { claimTimeoutMs: this.options.claimTimeoutMs }),
      eventType: "scan.requested",
      ...(this.options.limit === undefined ? {} : { limit: this.options.limit }),
      now,
      owner: this.options.owner,
    });
    let failed = 0;
    let published = 0;
    for (const event of events) {
      try {
        const input = dispatchInput(event);
        await this.dispatcher.dispatch(input);
        await new ScanJobCatalog(this.database).markDispatchState(
          input.scanJobId,
          "dispatched",
          now,
        );
        await markOutboxEventPublished(this.database, event.id, this.options.owner, now);
        published += 1;
      } catch (error) {
        failed += 1;
        await new ScanJobCatalog(this.database).markDispatchState(event.aggregateId, "failed", now);
        await releaseOutboxEvent(this.database, {
          error: { message: error instanceof Error ? error.message : "Dispatch failed" },
          id: event.id,
          owner: this.options.owner,
          retryAt: new Date(now.getTime() + this.options.retryBackoffMs),
        });
      }
    }
    return { attempted: events.length, failed, published };
  }
}
