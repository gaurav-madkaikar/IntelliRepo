import type { CatalogDatabase } from "@intellirepo/catalog";
import type { GraphNode } from "@intellirepo/graph";
import { sql, type Kysely } from "kysely";

import type { EntityLookup, StructuralEvidenceReader } from "./evidence-pack.js";
import type { EvidenceReference, QuestionIntent } from "./qa-model.js";

export class PostgresEntityLookup implements EntityLookup {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async find(
    repositoryId: string,
    searchTerm: string,
    _intent: QuestionIntent,
  ): Promise<readonly GraphNode[]> {
    void _intent;
    const term = `%${searchTerm.replace(/[%_]/gu, "")}%`;
    const rows = await this.database
      .selectFrom("entities")
      .select(["attributes", "id", "kind", "name", "qualified_name", "stable_key"])
      .where("repository_id", "=", repositoryId)
      .where((expression) =>
        expression.or([
          expression("name", "ilike", term),
          expression("qualified_name", "ilike", term),
          sql<boolean>`attributes::text ILIKE ${term}`,
        ]),
      )
      .orderBy("name")
      .limit(10)
      .execute();
    return rows.map((row) => ({
      attributes: row.attributes,
      id: row.id,
      kind: row.kind,
      name: row.name,
      ...(row.qualified_name === null ? {} : { qualifiedName: row.qualified_name }),
      stableKey: row.stable_key,
    }));
  }
}

export class PostgresStructuralEvidenceReader implements StructuralEvidenceReader {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async references(
    repositoryId: string,
    entityIds: readonly string[],
  ): Promise<readonly Omit<EvidenceReference, "id">[]> {
    if (entityIds.length === 0) return [];
    const rows = await this.database
      .selectFrom("provenance as fact_source")
      .innerJoin("entities as entity", "entity.id", "fact_source.entity_id")
      .innerJoin("source_artifacts as artifact", "artifact.id", "fact_source.artifact_id")
      .select([
        "entity.id as entity_id",
        "entity.name",
        "fact_source.confidence_score",
        "fact_source.end_line",
        "fact_source.evidence",
        "fact_source.start_line",
        "artifact.path",
      ])
      .where("entity.repository_id", "=", repositoryId)
      .where("entity.id", "in", [...entityIds])
      .orderBy("artifact.path")
      .orderBy("fact_source.start_line")
      .execute();
    return rows.map((row) => ({
      confidence: row.confidence_score,
      endLine: row.end_line,
      evidence: `${row.name}: ${row.evidence}`,
      path: row.path,
      sourceId: row.entity_id,
      sourceKind: "structural",
      startLine: row.start_line,
    }));
  }
}
