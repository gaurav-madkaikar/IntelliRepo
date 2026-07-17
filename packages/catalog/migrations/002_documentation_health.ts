import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE documentation_health (
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      revision_id text NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      score double precision NOT NULL CHECK (score >= 0 AND score <= 100),
      metrics jsonb NOT NULL,
      explanation text NOT NULL,
      calculated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (repository_id, revision_id)
    )
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS documentation_health`.execute(database);
}
