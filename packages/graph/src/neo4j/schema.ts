import type { Neo4jExecutor } from "./neo4j-executor.js";

export class Neo4jSchemaManager {
  public constructor(private readonly executor: Neo4jExecutor) {}

  public ensure(): Promise<void> {
    return this.executor.write([
      {
        cypher:
          "CREATE CONSTRAINT intellirepo_entity_identity IF NOT EXISTS FOR (node:IntelliRepoEntity) REQUIRE (node.repositoryId, node.id) IS UNIQUE",
        parameters: {},
      },
      {
        cypher:
          "CREATE CONSTRAINT intellirepo_projection_repository IF NOT EXISTS FOR (projection:IntelliRepoProjection) REQUIRE projection.repositoryId IS UNIQUE",
        parameters: {},
      },
      {
        cypher:
          "CREATE INDEX intellirepo_entity_stable_key IF NOT EXISTS FOR (node:IntelliRepoEntity) ON (node.repositoryId, node.stableKey)",
        parameters: {},
      },
    ]);
  }
}
