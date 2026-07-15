import { randomUUID } from "node:crypto";

import type { EntityFact, FactProvenance, RelationshipFact } from "@intellirepo/domain";
import type { Kysely, Transaction } from "kysely";

import type { CatalogDatabase } from "./database-types.js";
import { enqueueOutboxEvent } from "./outbox.js";

interface StoredEntityFact {
  readonly attributes: Record<string, unknown>;
  readonly kind: string;
  readonly language?: string;
  readonly name: string;
  readonly provenance: FactProvenance;
  readonly qualifiedName?: string;
  readonly stableKey: string;
}

interface StoredRelationshipFact {
  readonly attributes: Record<string, unknown>;
  readonly kind: string;
  readonly provenance: FactProvenance;
  readonly source: string;
  readonly target: string;
}

export interface StageFactSetInput {
  readonly artifactId: string;
  readonly entities: readonly EntityFact[];
  readonly id?: string;
  readonly relationships: readonly RelationshipFact[];
  readonly repositoryId: string;
  readonly revisionId: string;
}

function toJsonRecords(value: unknown): readonly Record<string, unknown>[] {
  return JSON.parse(JSON.stringify(value)) as readonly Record<string, unknown>[];
}

function asStoredEntities(value: readonly Record<string, unknown>[]): readonly StoredEntityFact[] {
  return value as unknown as readonly StoredEntityFact[];
}

function asStoredRelationships(
  value: readonly Record<string, unknown>[],
): readonly StoredRelationshipFact[] {
  return value as unknown as readonly StoredRelationshipFact[];
}

function provenanceValues(
  provenance: FactProvenance,
  artifactId: string,
  revisionId: string,
): Omit<CatalogDatabase["provenance"], "entity_id" | "id" | "relationship_id"> {
  return {
    artifact_id: artifactId,
    confidence_level: provenance.confidence.level,
    confidence_reason: provenance.confidence.reason,
    confidence_score: provenance.confidence.score,
    end_column: provenance.range.end.column,
    end_line: provenance.range.end.line,
    evidence: provenance.evidence,
    extractor: provenance.extractor,
    repository_revision_id: revisionId,
    start_column: provenance.range.start.column,
    start_line: provenance.range.start.line,
  };
}

export async function stageFactSet(
  database: Kysely<CatalogDatabase>,
  input: StageFactSetInput,
): Promise<string> {
  const id = input.id ?? randomUUID();

  await database
    .insertInto("fact_staging_runs")
    .values({
      activated_at: null,
      artifact_id: input.artifactId,
      entities: toJsonRecords(input.entities),
      id,
      relationships: toJsonRecords(input.relationships),
      repository_id: input.repositoryId,
      revision_id: input.revisionId,
      status: "staged",
    })
    .execute();

  return id;
}

async function replaceEntities(
  transaction: Transaction<CatalogDatabase>,
  repositoryId: string,
  artifactId: string,
  revisionId: string,
  entities: readonly StoredEntityFact[],
): Promise<Map<string, string>> {
  const stableKeys = entities.map(({ stableKey }) => stableKey);
  let obsoleteEntityDelete = transaction
    .deleteFrom("entities")
    .where("owner_artifact_id", "=", artifactId);

  if (stableKeys.length > 0) {
    obsoleteEntityDelete = obsoleteEntityDelete.where("stable_key", "not in", stableKeys);
  }
  await obsoleteEntityDelete.execute();

  for (const entity of entities) {
    const existing = await transaction
      .selectFrom("entities")
      .select(["id", "first_seen_revision_id"])
      .where("repository_id", "=", repositoryId)
      .where("stable_key", "=", entity.stableKey)
      .executeTakeFirst();
    const id = existing?.id ?? randomUUID();

    await transaction
      .insertInto("entities")
      .values({
        attributes: entity.attributes,
        first_seen_revision_id: existing?.first_seen_revision_id ?? revisionId,
        id,
        kind: entity.kind,
        language: entity.language ?? null,
        last_seen_revision_id: revisionId,
        name: entity.name,
        owner_artifact_id: artifactId,
        qualified_name: entity.qualifiedName ?? null,
        repository_id: repositoryId,
        stable_key: entity.stableKey,
      })
      .onConflict((conflict) =>
        conflict.columns(["repository_id", "stable_key"]).doUpdateSet({
          attributes: entity.attributes,
          kind: entity.kind,
          language: entity.language ?? null,
          last_seen_revision_id: revisionId,
          name: entity.name,
          owner_artifact_id: artifactId,
          qualified_name: entity.qualifiedName ?? null,
        }),
      )
      .execute();

    await transaction
      .insertInto("provenance")
      .values({
        ...provenanceValues(entity.provenance, artifactId, revisionId),
        entity_id: id,
        id: randomUUID(),
        relationship_id: null,
      })
      .execute();
  }

  const referencedKeys = new Set(stableKeys);
  const rows =
    referencedKeys.size === 0
      ? []
      : await transaction
          .selectFrom("entities")
          .select(["id", "stable_key"])
          .where("repository_id", "=", repositoryId)
          .where("stable_key", "in", [...referencedKeys])
          .execute();

  return new Map(rows.map(({ id, stable_key: stableKey }) => [stableKey, id]));
}

async function replaceRelationships(
  transaction: Transaction<CatalogDatabase>,
  repositoryId: string,
  artifactId: string,
  revisionId: string,
  relationships: readonly StoredRelationshipFact[],
): Promise<void> {
  await transaction
    .deleteFrom("relationships")
    .where("owner_artifact_id", "=", artifactId)
    .execute();

  const referencedKeys = [
    ...new Set(relationships.flatMap(({ source, target }) => [source, target])),
  ];
  const referencedEntities =
    referencedKeys.length === 0
      ? []
      : await transaction
          .selectFrom("entities")
          .select(["id", "stable_key"])
          .where("repository_id", "=", repositoryId)
          .where("stable_key", "in", referencedKeys)
          .execute();
  const entityIds = new Map(
    referencedEntities.map(({ id, stable_key: stableKey }) => [stableKey, id]),
  );

  for (const relationship of relationships) {
    const sourceEntityId = entityIds.get(relationship.source);
    const targetEntityId = entityIds.get(relationship.target);

    if (sourceEntityId === undefined || targetEntityId === undefined) {
      throw new Error(
        `Relationship ${relationship.kind} references an unresolved source or target entity`,
      );
    }

    const id = randomUUID();
    await transaction
      .insertInto("relationships")
      .values({
        attributes: relationship.attributes,
        first_seen_revision_id: revisionId,
        id,
        kind: relationship.kind,
        last_seen_revision_id: revisionId,
        owner_artifact_id: artifactId,
        repository_id: repositoryId,
        source_entity_id: sourceEntityId,
        target_entity_id: targetEntityId,
      })
      .execute();
    await transaction
      .insertInto("provenance")
      .values({
        ...provenanceValues(relationship.provenance, artifactId, revisionId),
        entity_id: null,
        id: randomUUID(),
        relationship_id: id,
      })
      .execute();
  }
}

export async function activateFactSet(
  database: Kysely<CatalogDatabase>,
  stagingRunId: string,
): Promise<void> {
  await database.transaction().execute(async (transaction) => {
    const stagingRun = await transaction
      .selectFrom("fact_staging_runs")
      .selectAll()
      .where("id", "=", stagingRunId)
      .forUpdate()
      .executeTakeFirstOrThrow();

    if (stagingRun.status === "active") {
      return;
    }
    if (stagingRun.status !== "staged") {
      throw new Error(`Staging run ${stagingRunId} cannot be activated from ${stagingRun.status}`);
    }

    const entities = asStoredEntities(stagingRun.entities);
    const relationships = asStoredRelationships(stagingRun.relationships);

    await transaction
      .deleteFrom("provenance")
      .where("artifact_id", "=", stagingRun.artifact_id)
      .execute();
    await replaceEntities(
      transaction,
      stagingRun.repository_id,
      stagingRun.artifact_id,
      stagingRun.revision_id,
      entities,
    );
    await replaceRelationships(
      transaction,
      stagingRun.repository_id,
      stagingRun.artifact_id,
      stagingRun.revision_id,
      relationships,
    );
    await transaction
      .updateTable("source_artifacts")
      .set({ active_revision_id: stagingRun.revision_id, last_indexed_at: new Date() })
      .where("id", "=", stagingRun.artifact_id)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("fact_staging_runs")
      .set({ activated_at: new Date(), status: "active" })
      .where("id", "=", stagingRunId)
      .executeTakeFirstOrThrow();
    await enqueueOutboxEvent(transaction, {
      aggregateId: stagingRun.repository_id,
      eventType: "facts.activated",
      idempotencyKey: `facts:${stagingRun.repository_id}:${stagingRun.revision_id}:${stagingRun.artifact_id}`,
      payload: {
        artifactId: stagingRun.artifact_id,
        repositoryId: stagingRun.repository_id,
        revisionId: stagingRun.revision_id,
      },
    });
  });
}
