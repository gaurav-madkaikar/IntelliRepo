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

export interface ActivateRevisionFactsInput {
  readonly deletedArtifactIds?: readonly string[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly stagingRunIds: readonly string[];
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

async function activateRevisionTransaction(
  transaction: Transaction<CatalogDatabase>,
  input: ActivateRevisionFactsInput,
): Promise<void> {
  const stagingRunIds = [...new Set(input.stagingRunIds)];
  const deletedArtifactIds = [...new Set(input.deletedArtifactIds ?? [])];

  if (stagingRunIds.length !== input.stagingRunIds.length) {
    throw new Error("Revision activation cannot contain duplicate staging run ids");
  }

  const stagingRuns =
    stagingRunIds.length === 0
      ? []
      : await transaction
          .selectFrom("fact_staging_runs")
          .selectAll()
          .where("id", "in", stagingRunIds)
          .forUpdate()
          .execute();

  if (stagingRuns.length !== stagingRunIds.length) {
    throw new Error("Revision activation references an unknown staging run");
  }
  for (const stagingRun of stagingRuns) {
    if (
      stagingRun.repository_id !== input.repositoryId ||
      stagingRun.revision_id !== input.revisionId
    ) {
      throw new Error("All staging runs must belong to the activated repository revision");
    }
  }

  const statuses = new Set(stagingRuns.map(({ status }) => status));
  if (statuses.size === 1 && statuses.has("active")) return;
  if (stagingRuns.length === 0) {
    const completed = await transaction
      .selectFrom("outbox_events")
      .select("id")
      .where("idempotency_key", "=", `facts:${input.repositoryId}:${input.revisionId}`)
      .executeTakeFirst();
    if (completed !== undefined) return;
  }
  if (statuses.size > 1 || (statuses.size === 1 && !statuses.has("staged"))) {
    throw new Error("Revision activation requires staging runs to share the staged status");
  }

  const changedArtifactIds = stagingRuns.map(({ artifact_id: artifactId }) => artifactId);
  if (new Set(changedArtifactIds).size !== changedArtifactIds.length) {
    throw new Error("Revision activation cannot stage the same artifact more than once");
  }
  const deletedArtifactSet = new Set(deletedArtifactIds);
  if (changedArtifactIds.some((artifactId) => deletedArtifactSet.has(artifactId))) {
    throw new Error("An artifact cannot be changed and deleted in the same activation");
  }
  const affectedArtifactIds = [...changedArtifactIds, ...deletedArtifactIds];
  const affectedArtifacts =
    affectedArtifactIds.length === 0
      ? []
      : await transaction
          .selectFrom("source_artifacts")
          .select(["id", "repository_id"])
          .where("id", "in", affectedArtifactIds)
          .forUpdate()
          .execute();
  if (
    affectedArtifacts.length !== affectedArtifactIds.length ||
    affectedArtifacts.some(({ repository_id: repositoryId }) => repositoryId !== input.repositoryId)
  ) {
    throw new Error("Every affected artifact must belong to the activated repository");
  }

  const revision = await transaction
    .selectFrom("revisions")
    .select(["id", "repository_id"])
    .where("id", "=", input.revisionId)
    .forUpdate()
    .executeTakeFirstOrThrow();
  if (revision.repository_id !== input.repositoryId) {
    throw new Error("Revision does not belong to the activated repository");
  }

  if (affectedArtifactIds.length > 0) {
    await transaction
      .deleteFrom("provenance")
      .where("artifact_id", "in", affectedArtifactIds)
      .execute();
    await transaction
      .deleteFrom("relationships")
      .where("owner_artifact_id", "in", affectedArtifactIds)
      .execute();
  }

  if (deletedArtifactIds.length > 0) {
    await transaction
      .deleteFrom("source_artifacts")
      .where("repository_id", "=", input.repositoryId)
      .where("id", "in", deletedArtifactIds)
      .execute();
  }

  // Insert every entity before resolving any edge. This makes relationship activation
  // independent of changed-file order and permits cross-file references in one revision.
  for (const stagingRun of stagingRuns) {
    await replaceEntities(
      transaction,
      input.repositoryId,
      stagingRun.artifact_id,
      input.revisionId,
      asStoredEntities(stagingRun.entities),
    );
  }
  for (const stagingRun of stagingRuns) {
    await replaceRelationships(
      transaction,
      input.repositoryId,
      stagingRun.artifact_id,
      input.revisionId,
      asStoredRelationships(stagingRun.relationships),
    );
  }

  if (changedArtifactIds.length > 0) {
    await transaction
      .updateTable("source_artifacts")
      .set({ active_revision_id: input.revisionId, last_indexed_at: new Date() })
      .where("repository_id", "=", input.repositoryId)
      .where("id", "in", changedArtifactIds)
      .execute();
    await transaction
      .updateTable("fact_staging_runs")
      .set({ activated_at: new Date(), status: "active" })
      .where("id", "in", stagingRunIds)
      .execute();
  }

  await transaction
    .updateTable("revisions")
    .set({ status: "superseded" })
    .where("repository_id", "=", input.repositoryId)
    .where("id", "!=", input.revisionId)
    .where("status", "=", "active")
    .execute();
  await transaction
    .updateTable("revisions")
    .set({ status: "active" })
    .where("id", "=", input.revisionId)
    .executeTakeFirstOrThrow();

  await enqueueOutboxEvent(transaction, {
    aggregateId: input.repositoryId,
    eventType: "facts.revision-activated",
    idempotencyKey: `facts:${input.repositoryId}:${input.revisionId}`,
    payload: {
      changedArtifactIds,
      deletedArtifactIds,
      repositoryId: input.repositoryId,
      revisionId: input.revisionId,
    },
  });
}

/**
 * Atomically swaps all facts affected by one repository revision. Unchanged artifacts and
 * their facts are deliberately not updated, so incremental indexing retains their identity.
 */
export async function activateRevisionFacts(
  database: Kysely<CatalogDatabase>,
  input: ActivateRevisionFactsInput,
): Promise<void> {
  await database
    .transaction()
    .execute((transaction) => activateRevisionTransaction(transaction, input));
}

export async function activateFactSet(
  database: Kysely<CatalogDatabase>,
  stagingRunId: string,
): Promise<void> {
  const stagingRun = await database
    .selectFrom("fact_staging_runs")
    .select(["repository_id", "revision_id"])
    .where("id", "=", stagingRunId)
    .executeTakeFirstOrThrow();
  await activateRevisionFacts(database, {
    repositoryId: stagingRun.repository_id,
    revisionId: stagingRun.revision_id,
    stagingRunIds: [stagingRunId],
  });
}
