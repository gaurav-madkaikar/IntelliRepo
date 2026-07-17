import type { ColumnType, JSONColumnType } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type NullableTimestamp = ColumnType<
  Date | null,
  Date | string | null | undefined,
  Date | string | null
>;
type JsonObjectValue = Record<string, unknown>;
type JsonObject = JSONColumnType<JsonObjectValue, JsonObjectValue, JsonObjectValue>;
type NullableJsonObject = JSONColumnType<
  JsonObjectValue | null,
  JsonObjectValue | null,
  JsonObjectValue | null
>;
type JsonArrayValue = readonly Record<string, unknown>[];
type JsonArray = JSONColumnType<JsonArrayValue, JsonArrayValue, JsonArrayValue>;
type StringArray = JSONColumnType<readonly string[], readonly string[], readonly string[]>;

export interface RepositoryTable {
  created_at: Timestamp;
  default_branch: string | null;
  display_name: string;
  id: string;
  root_path: string;
  settings: JsonObject;
}

export interface RevisionTable {
  commit_sha: string;
  created_at: Timestamp;
  id: string;
  parent_revision_id: string | null;
  repository_id: string;
  status: string;
  worktree_fingerprint: string;
}

export interface SourceArtifactTable {
  active_revision_id: string | null;
  artifact_kind: string;
  content_hash: string;
  created_at: Timestamp;
  id: string;
  language: string | null;
  last_indexed_at: NullableTimestamp;
  path: string;
  repository_id: string;
  size_bytes: number;
}

export interface EntityTable {
  attributes: JsonObject;
  first_seen_revision_id: string;
  id: string;
  kind: string;
  language: string | null;
  last_seen_revision_id: string;
  name: string;
  owner_artifact_id: string;
  qualified_name: string | null;
  repository_id: string;
  stable_key: string;
}

export interface RelationshipTable {
  attributes: JsonObject;
  first_seen_revision_id: string;
  id: string;
  kind: string;
  last_seen_revision_id: string;
  owner_artifact_id: string;
  repository_id: string;
  source_entity_id: string;
  target_entity_id: string;
}

export interface ProvenanceTable {
  artifact_id: string;
  confidence_level: string;
  confidence_reason: string;
  confidence_score: number;
  end_column: number;
  end_line: number;
  entity_id: string | null;
  evidence: string;
  extractor: string;
  id: string;
  relationship_id: string | null;
  repository_revision_id: string;
  start_column: number;
  start_line: number;
}

export interface FactStagingRunTable {
  activated_at: NullableTimestamp;
  artifact_id: string;
  created_at: Timestamp;
  entities: JsonArray;
  id: string;
  relationships: JsonArray;
  repository_id: string;
  revision_id: string;
  status: string;
}

export interface ScanJobTable {
  attempt: number;
  completed_at: NullableTimestamp;
  completed_stages: StringArray;
  created_at: Timestamp;
  current_stage: string | null;
  degraded_reasons: StringArray;
  error: NullableJsonObject;
  id: string;
  repository_id: string;
  revision_id: string;
  stage_timings: JsonObject;
  started_at: NullableTimestamp;
  state: string;
  updated_at: Timestamp;
}

export interface JobAttemptTable {
  attempt: number;
  completed_at: NullableTimestamp;
  error: NullableJsonObject;
  id: string;
  scan_job_id: string;
  stage: string | null;
  started_at: Timestamp;
  state: string;
}

export interface OutboxEventTable {
  aggregate_id: string;
  created_at: Timestamp;
  event_type: string;
  id: string;
  idempotency_key: string;
  payload: JsonObject;
  published_at: NullableTimestamp;
}

export interface ProjectionStateTable {
  error: NullableJsonObject;
  projection: string;
  repository_id: string;
  revision_id: string | null;
  state: string;
  updated_at: Timestamp;
}

export interface ImpactReportTable {
  base_revision_id: string;
  created_at: Timestamp;
  id: string;
  markdown: string;
  report: JsonObject;
  repository_id: string;
  target_revision_id: string;
}

export interface TestRecommendationTable {
  confidence_level: string;
  evidence_path: JsonArray;
  id: string;
  impact_report_id: string;
  reason: string;
  score: number;
  test_entity_id: string;
}

export interface RiskFactorTable {
  evidence: JsonObject;
  explanation: string;
  factor: string;
  id: string;
  impact_report_id: string;
  weight: number;
}

export interface DocumentPageTable {
  attributes: JsonObject;
  id: string;
  path: string;
  repository_id: string;
  revision_id: string;
  title: string | null;
}

export interface DocumentSectionTable {
  heading: string;
  id: string;
  level: number;
  line_end: number;
  line_start: number;
  page_id: string;
  stable_key: string;
}

export interface DocumentClaimTable {
  claim_kind: string;
  confidence_score: number;
  id: string;
  payload: JsonObject;
  section_id: string;
  source_text: string;
}

export interface DocumentationFindingTable {
  claim_id: string | null;
  created_at: Timestamp;
  evidence: JsonObject;
  finding_kind: string;
  id: string;
  repository_id: string;
  revision_id: string;
  severity: string;
  status: string;
}

export interface DocumentationReviewTable {
  applied_at: NullableTimestamp;
  created_at: Timestamp;
  diff: string;
  finding_id: string | null;
  id: string;
  proposed_markdown: string;
  repository_id: string;
  revision_id: string;
  state: string;
}

export interface DocumentationHealthTable {
  calculated_at: Timestamp;
  explanation: string;
  metrics: JsonObject;
  repository_id: string;
  revision_id: string;
  score: number;
}

interface UnusedTable {
  id: string;
}

export interface CatalogDatabase {
  answer_references: UnusedTable;
  document_claims: DocumentClaimTable;
  document_pages: DocumentPageTable;
  document_sections: DocumentSectionTable;
  documentation_findings: DocumentationFindingTable;
  documentation_health: DocumentationHealthTable;
  documentation_reviews: DocumentationReviewTable;
  entities: EntityTable;
  fact_staging_runs: FactStagingRunTable;
  impact_reports: ImpactReportTable;
  job_attempts: JobAttemptTable;
  outbox_events: OutboxEventTable;
  projection_states: ProjectionStateTable;
  provenance: ProvenanceTable;
  question_sessions: UnusedTable;
  questions: UnusedTable;
  relationships: RelationshipTable;
  repositories: RepositoryTable;
  revisions: RevisionTable;
  risk_factors: RiskFactorTable;
  scan_jobs: ScanJobTable;
  semantic_chunks: UnusedTable;
  source_artifacts: SourceArtifactTable;
  test_recommendations: TestRecommendationTable;
}
