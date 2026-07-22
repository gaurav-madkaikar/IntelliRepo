import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE revision_fact_snapshots (
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      revision_id text NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      entities jsonb NOT NULL,
      relationships jsonb NOT NULL,
      captured_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (repository_id, revision_id)
    );
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS revision_fact_snapshots`.execute(database);
}
