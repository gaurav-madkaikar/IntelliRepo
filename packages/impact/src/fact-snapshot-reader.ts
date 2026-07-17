import type { CatalogDatabase } from "@intellirepo/catalog";
import type { Kysely } from "kysely";

import type {
  FactSnapshot,
  SnapshotEntity,
  SnapshotRelationship,
  SourceReference,
} from "./impact-model.js";

function sourceReference(row: {
  artifact_path: string | null;
  end_line: number | null;
  evidence: string | null;
  start_line: number | null;
}): SourceReference | undefined {
  if (row.artifact_path === null || row.evidence === null) return undefined;
  return {
    artifactPath: row.artifact_path,
    ...(row.end_line === null ? {} : { endLine: row.end_line }),
    evidence: row.evidence,
    ...(row.start_line === null ? {} : { startLine: row.start_line }),
  };
}

/**
 * Captures current canonical facts under a revision label. Retain the base result before
 * activation, then capture the target result afterward for semantic comparison.
 */
export class PostgresFactSnapshotReader {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async read(repositoryId: string, revisionId: string): Promise<FactSnapshot> {
    const revision = await this.database
      .selectFrom("revisions")
      .select("id")
      .where("id", "=", revisionId)
      .where("repository_id", "=", repositoryId)
      .executeTakeFirst();
    if (revision === undefined) throw new Error(`Unknown repository revision ${revisionId}`);

    const entityRows = await this.database
      .selectFrom("entities as entity")
      .leftJoin("provenance as fact_source", "fact_source.entity_id", "entity.id")
      .leftJoin("source_artifacts as artifact", "artifact.id", "fact_source.artifact_id")
      .select([
        "entity.attributes",
        "entity.id",
        "entity.kind",
        "entity.language",
        "entity.name",
        "entity.qualified_name",
        "entity.stable_key",
        "fact_source.confidence_score",
        "fact_source.end_line",
        "fact_source.evidence",
        "fact_source.start_line",
        "artifact.path as artifact_path",
      ])
      .where("entity.repository_id", "=", repositoryId)
      .execute();
    const entities: SnapshotEntity[] = entityRows.map((row) => {
      const source = sourceReference(row);
      return {
        attributes: row.attributes,
        ...(row.confidence_score === null ? {} : { confidence: row.confidence_score }),
        id: row.id,
        kind: row.kind,
        ...(row.language === null ? {} : { language: row.language }),
        name: row.name,
        ...(row.qualified_name === null ? {} : { qualifiedName: row.qualified_name }),
        ...(source === undefined ? {} : { source }),
        stableKey: row.stable_key,
      };
    });

    const relationshipRows = await this.database
      .selectFrom("relationships as relationship")
      .innerJoin("entities as source_entity", "source_entity.id", "relationship.source_entity_id")
      .innerJoin("entities as target_entity", "target_entity.id", "relationship.target_entity_id")
      .leftJoin("provenance as fact_source", "fact_source.relationship_id", "relationship.id")
      .leftJoin("source_artifacts as artifact", "artifact.id", "fact_source.artifact_id")
      .select([
        "relationship.attributes",
        "relationship.id",
        "relationship.kind",
        "source_entity.stable_key as source_entity_key",
        "target_entity.stable_key as target_entity_key",
        "fact_source.confidence_score",
        "fact_source.end_line",
        "fact_source.evidence",
        "fact_source.start_line",
        "artifact.path as artifact_path",
      ])
      .where("relationship.repository_id", "=", repositoryId)
      .execute();
    const relationships: SnapshotRelationship[] = relationshipRows.map((row) => {
      const reference = sourceReference(row);
      return {
        attributes: row.attributes,
        ...(row.confidence_score === null ? {} : { confidence: row.confidence_score }),
        id: row.id,
        kind: row.kind,
        sourceEntityKey: row.source_entity_key,
        ...(reference === undefined ? {} : { sourceReference: reference }),
        targetEntityKey: row.target_entity_key,
      };
    });
    return { entities, relationships, repositoryId, revisionId };
  }
}
