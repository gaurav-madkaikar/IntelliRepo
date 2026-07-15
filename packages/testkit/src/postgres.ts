import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

export interface PostgresTestContainer {
  readonly connectionUri: string;
  stop(): Promise<void>;
}

export async function startPostgresTestContainer(): Promise<PostgresTestContainer> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer(
    "pgvector/pgvector:pg17",
  )
    .withDatabase("intellirepo_test")
    .withUsername("intellirepo")
    .withPassword("intellirepo")
    .start();

  return {
    connectionUri: container.getConnectionUri(),
    stop: () => container.stop().then(() => undefined),
  };
}
