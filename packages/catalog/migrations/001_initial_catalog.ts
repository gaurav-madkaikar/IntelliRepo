import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.execute(database);

  await sql`
    CREATE TABLE repositories (
      id text PRIMARY KEY,
      display_name text NOT NULL,
      root_path text NOT NULL UNIQUE,
      default_branch text,
      settings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE revisions (
      id text PRIMARY KEY,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      commit_sha text NOT NULL,
      worktree_fingerprint text NOT NULL,
      parent_revision_id text REFERENCES revisions(id),
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repository_id, commit_sha, worktree_fingerprint)
    );

    CREATE TABLE source_artifacts (
      id text PRIMARY KEY,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      path text NOT NULL,
      artifact_kind text NOT NULL,
      language text,
      content_hash text NOT NULL,
      size_bytes integer NOT NULL CHECK (size_bytes >= 0),
      active_revision_id text REFERENCES revisions(id),
      last_indexed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (repository_id, path)
    );

    CREATE TABLE entities (
      id text PRIMARY KEY,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      owner_artifact_id text NOT NULL REFERENCES source_artifacts(id) ON DELETE CASCADE,
      stable_key text NOT NULL,
      kind text NOT NULL,
      name text NOT NULL,
      qualified_name text,
      language text,
      attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      first_seen_revision_id text NOT NULL REFERENCES revisions(id),
      last_seen_revision_id text NOT NULL REFERENCES revisions(id),
      UNIQUE (repository_id, stable_key)
    );

    CREATE TABLE relationships (
      id text PRIMARY KEY,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      owner_artifact_id text NOT NULL REFERENCES source_artifacts(id) ON DELETE CASCADE,
      source_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      target_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
      kind text NOT NULL,
      attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
      first_seen_revision_id text NOT NULL REFERENCES revisions(id),
      last_seen_revision_id text NOT NULL REFERENCES revisions(id)
    );

    CREATE INDEX relationships_source_idx ON relationships(repository_id, source_entity_id);
    CREATE INDEX relationships_target_idx ON relationships(repository_id, target_entity_id);

    CREATE TABLE provenance (
      id text PRIMARY KEY,
      artifact_id text NOT NULL REFERENCES source_artifacts(id) ON DELETE CASCADE,
      entity_id text REFERENCES entities(id) ON DELETE CASCADE,
      relationship_id text REFERENCES relationships(id) ON DELETE CASCADE,
      repository_revision_id text NOT NULL REFERENCES revisions(id),
      start_line integer NOT NULL CHECK (start_line > 0),
      start_column integer NOT NULL CHECK (start_column > 0),
      end_line integer NOT NULL CHECK (end_line > 0),
      end_column integer NOT NULL CHECK (end_column > 0),
      extractor text NOT NULL,
      evidence text NOT NULL,
      confidence_level text NOT NULL,
      confidence_score double precision NOT NULL CHECK (confidence_score >= 0 AND confidence_score <= 1),
      confidence_reason text NOT NULL,
      CHECK ((entity_id IS NULL) <> (relationship_id IS NULL))
    );

    CREATE TABLE fact_staging_runs (
      id text PRIMARY KEY,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      revision_id text NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      artifact_id text NOT NULL REFERENCES source_artifacts(id) ON DELETE CASCADE,
      status text NOT NULL,
      entities jsonb NOT NULL,
      relationships jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      activated_at timestamptz
    );

    CREATE TABLE scan_jobs (
      id text PRIMARY KEY,
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      revision_id text NOT NULL REFERENCES revisions(id) ON DELETE CASCADE,
      state text NOT NULL,
      current_stage text,
      completed_stages jsonb NOT NULL DEFAULT '[]'::jsonb,
      degraded_reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      stage_timings jsonb NOT NULL DEFAULT '{}'::jsonb,
      attempt integer NOT NULL DEFAULT 0,
      error jsonb,
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE job_attempts (
      id text PRIMARY KEY,
      scan_job_id text NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
      attempt integer NOT NULL,
      stage text,
      state text NOT NULL,
      error jsonb,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      UNIQUE (scan_job_id, attempt)
    );

    CREATE TABLE outbox_events (
      id text PRIMARY KEY,
      aggregate_id text NOT NULL,
      event_type text NOT NULL,
      idempotency_key text NOT NULL UNIQUE,
      payload jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      published_at timestamptz
    );

    CREATE TABLE projection_states (
      repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      projection text NOT NULL,
      revision_id text REFERENCES revisions(id),
      state text NOT NULL,
      error jsonb,
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (repository_id, projection)
    );

    CREATE TABLE document_pages (id text PRIMARY KEY, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, path text NOT NULL, title text, revision_id text NOT NULL REFERENCES revisions(id), attributes jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(repository_id, path));
    CREATE TABLE document_sections (id text PRIMARY KEY, page_id text NOT NULL REFERENCES document_pages(id) ON DELETE CASCADE, stable_key text NOT NULL, heading text NOT NULL, level integer NOT NULL, line_start integer NOT NULL, line_end integer NOT NULL, UNIQUE(page_id, stable_key));
    CREATE TABLE document_claims (id text PRIMARY KEY, section_id text NOT NULL REFERENCES document_sections(id) ON DELETE CASCADE, claim_kind text NOT NULL, payload jsonb NOT NULL, confidence_score double precision NOT NULL, source_text text NOT NULL);
    CREATE TABLE documentation_findings (id text PRIMARY KEY, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, revision_id text NOT NULL REFERENCES revisions(id), claim_id text REFERENCES document_claims(id) ON DELETE CASCADE, finding_kind text NOT NULL, severity text NOT NULL, evidence jsonb NOT NULL, status text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE documentation_reviews (id text PRIMARY KEY, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, revision_id text NOT NULL REFERENCES revisions(id), finding_id text REFERENCES documentation_findings(id), proposed_markdown text NOT NULL, diff text NOT NULL, state text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), applied_at timestamptz);
    CREATE TABLE semantic_chunks (id text PRIMARY KEY, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, revision_id text NOT NULL REFERENCES revisions(id), source_kind text NOT NULL, source_id text NOT NULL, checksum text NOT NULL, redacted_content text NOT NULL, embedding vector, metadata jsonb NOT NULL DEFAULT '{}'::jsonb, UNIQUE(repository_id, source_kind, source_id, checksum));
    CREATE TABLE impact_reports (id text PRIMARY KEY, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, base_revision_id text NOT NULL REFERENCES revisions(id), target_revision_id text NOT NULL REFERENCES revisions(id), report jsonb NOT NULL, markdown text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(repository_id, base_revision_id, target_revision_id));
    CREATE TABLE test_recommendations (id text PRIMARY KEY, impact_report_id text NOT NULL REFERENCES impact_reports(id) ON DELETE CASCADE, test_entity_id text NOT NULL REFERENCES entities(id) ON DELETE CASCADE, score double precision NOT NULL, confidence_level text NOT NULL, reason text NOT NULL, evidence_path jsonb NOT NULL);
    CREATE TABLE risk_factors (id text PRIMARY KEY, impact_report_id text NOT NULL REFERENCES impact_reports(id) ON DELETE CASCADE, factor text NOT NULL, weight double precision NOT NULL, explanation text NOT NULL, evidence jsonb NOT NULL);
    CREATE TABLE question_sessions (id text PRIMARY KEY, repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, revision_id text NOT NULL REFERENCES revisions(id), created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE questions (id text PRIMARY KEY, session_id text NOT NULL REFERENCES question_sessions(id) ON DELETE CASCADE, question text NOT NULL, intent text, answer text, confidence_level text, degraded boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE answer_references (id text PRIMARY KEY, question_id text NOT NULL REFERENCES questions(id) ON DELETE CASCADE, source_kind text NOT NULL, source_id text NOT NULL, artifact_path text NOT NULL, line_start integer, line_end integer, evidence text NOT NULL);
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS answer_references, questions, question_sessions, risk_factors,
      test_recommendations, impact_reports, semantic_chunks, documentation_reviews,
      documentation_findings, document_claims, document_sections, document_pages,
      projection_states, outbox_events, job_attempts, scan_jobs, fact_staging_runs,
      provenance, relationships, entities, source_artifacts, revisions, repositories CASCADE
  `.execute(database);
}
