import { createHash } from "node:crypto";

export const SCAN_STAGES = [
  "DISCOVERING",
  "PARSING",
  "RESOLVING",
  "COMMITTING_FACTS",
  "PROJECTING_GRAPH",
  "EMBEDDING",
  "ANALYZING",
] as const;

export type ScanStage = (typeof SCAN_STAGES)[number];

export const SCAN_JOB_STATES = ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"] as const;

export type ScanJobState = (typeof SCAN_JOB_STATES)[number];

export interface ScanJobRequest {
  readonly repositoryId: string;
  readonly revisionId: string;
}

export interface ScanStageTiming {
  readonly completedAt?: string;
  readonly durationMs?: number;
  readonly startedAt: string;
}

export interface ScanJobError {
  readonly message: string;
  readonly recoverable: boolean;
  readonly stage: ScanStage;
}

export interface ScanJobSnapshot extends ScanJobRequest {
  readonly attempt: number;
  readonly completedAt?: string;
  readonly completedStages: readonly ScanStage[];
  readonly createdAt: string;
  readonly currentStage?: ScanStage;
  readonly degradedReasons: readonly string[];
  readonly error?: ScanJobError;
  readonly id: string;
  readonly stageTimings: Readonly<Partial<Record<ScanStage, ScanStageTiming>>>;
  readonly startedAt?: string;
  readonly state: ScanJobState;
  readonly updatedAt: string;
}

function requiredIdentifier(name: string, value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${name} must not be empty`);
  }
  return normalized;
}

export function createScanJobId(request: ScanJobRequest): string {
  const repositoryId = requiredIdentifier("repositoryId", request.repositoryId);
  const revisionId = requiredIdentifier("revisionId", request.revisionId);
  const digest = createHash("sha256")
    .update(`${repositoryId}\u001f${revisionId}`)
    .digest("hex")
    .slice(0, 24);
  return `scan-${digest}`;
}

export function nextScanStage(stage: ScanStage): ScanStage | undefined {
  return SCAN_STAGES[SCAN_STAGES.indexOf(stage) + 1];
}

export function isOptionalScanStage(stage: ScanStage): boolean {
  return stage === "EMBEDDING";
}
