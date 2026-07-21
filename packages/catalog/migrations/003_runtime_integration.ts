import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE revisions
      ADD CONSTRAINT revisions_repository_id_id_unique UNIQUE (repository_id, id);

    ALTER TABLE scan_jobs
      ADD COLUMN dispatch_mode text NOT NULL DEFAULT 'bullmq',
      ADD COLUMN dispatch_state text NOT NULL DEFAULT 'pending',
      ADD COLUMN counts jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN lease_owner text,
      ADD COLUMN lease_expires_at timestamptz,
      ADD COLUMN heartbeat_at timestamptz,
      ADD COLUMN recoverable_stage text,
      ADD CONSTRAINT scan_jobs_repository_revision_fk
        FOREIGN KEY (repository_id, revision_id)
        REFERENCES revisions(repository_id, id) ON DELETE CASCADE;

    ALTER TABLE outbox_events
      ADD COLUMN claim_owner text,
      ADD COLUMN claimed_at timestamptz,
      ADD COLUMN next_attempt_at timestamptz NOT NULL DEFAULT now(),
      ADD COLUMN publish_attempt integer NOT NULL DEFAULT 0 CHECK (publish_attempt >= 0),
      ADD COLUMN last_error jsonb;

    ALTER TABLE documentation_reviews
      ADD COLUMN target_path text NOT NULL DEFAULT '',
      ADD COLUMN original_checksum text NOT NULL DEFAULT '',
      ADD COLUMN request jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
      ADD CONSTRAINT documentation_reviews_repository_revision_fk
        FOREIGN KEY (repository_id, revision_id)
        REFERENCES revisions(repository_id, id) ON DELETE CASCADE;

    CREATE TABLE question_tasks (
      id text PRIMARY KEY,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      revision_id text NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      question text NOT NULL,
      state text NOT NULL,
      result jsonb,
      error jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT question_tasks_repository_revision_fk
        FOREIGN KEY (repository_id, revision_id)
        REFERENCES revisions(repository_id, id) ON DELETE CASCADE
    );

    CREATE INDEX scan_jobs_recoverable_idx
      ON scan_jobs(repository_id, updated_at)
      WHERE state = 'FAILED';
    CREATE INDEX scan_jobs_lease_idx
      ON scan_jobs(lease_expires_at)
      WHERE lease_owner IS NOT NULL;
    CREATE INDEX outbox_events_pending_idx
      ON outbox_events(next_attempt_at, created_at)
      WHERE published_at IS NULL;
    CREATE INDEX question_tasks_polling_idx
      ON question_tasks(repository_id, updated_at DESC);
    CREATE INDEX documentation_reviews_revision_idx
      ON documentation_reviews(repository_id, revision_id, state);
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    DROP INDEX IF EXISTS documentation_reviews_revision_idx;
    DROP INDEX IF EXISTS question_tasks_polling_idx;
    DROP INDEX IF EXISTS outbox_events_pending_idx;
    DROP INDEX IF EXISTS scan_jobs_lease_idx;
    DROP INDEX IF EXISTS scan_jobs_recoverable_idx;

    DROP TABLE IF EXISTS question_tasks;

    ALTER TABLE documentation_reviews
      DROP CONSTRAINT IF EXISTS documentation_reviews_repository_revision_fk,
      DROP COLUMN IF EXISTS explanation,
      DROP COLUMN IF EXISTS manifest,
      DROP COLUMN IF EXISTS request,
      DROP COLUMN IF EXISTS original_checksum,
      DROP COLUMN IF EXISTS target_path;

    ALTER TABLE outbox_events
      DROP COLUMN IF EXISTS last_error,
      DROP COLUMN IF EXISTS publish_attempt,
      DROP COLUMN IF EXISTS next_attempt_at,
      DROP COLUMN IF EXISTS claimed_at,
      DROP COLUMN IF EXISTS claim_owner;

    ALTER TABLE scan_jobs
      DROP CONSTRAINT IF EXISTS scan_jobs_repository_revision_fk,
      DROP COLUMN IF EXISTS recoverable_stage,
      DROP COLUMN IF EXISTS heartbeat_at,
      DROP COLUMN IF EXISTS lease_expires_at,
      DROP COLUMN IF EXISTS lease_owner,
      DROP COLUMN IF EXISTS diagnostics,
      DROP COLUMN IF EXISTS counts,
      DROP COLUMN IF EXISTS dispatch_state,
      DROP COLUMN IF EXISTS dispatch_mode;

    ALTER TABLE revisions
      DROP CONSTRAINT IF EXISTS revisions_repository_id_id_unique;
  `.execute(database);
}
