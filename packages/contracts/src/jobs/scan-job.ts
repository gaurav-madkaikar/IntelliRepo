import { createHash } from "node:crypto";

import { z } from "zod";

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

export const scanStageSchema = z.enum(SCAN_STAGES);
export const scanJobStateSchema = z.enum(SCAN_JOB_STATES);

export const INDEXING_DISPATCH_MODES = ["bullmq", "inline"] as const;

export type IndexingDispatchMode = (typeof INDEXING_DISPATCH_MODES)[number];

export const indexingDispatchModeSchema = z.enum(INDEXING_DISPATCH_MODES);

export const SCAN_DISPATCH_STATES = ["pending", "dispatched", "failed"] as const;

export type ScanDispatchState = (typeof SCAN_DISPATCH_STATES)[number];

export const scanDispatchStateSchema = z.enum(SCAN_DISPATCH_STATES);

export type ScanDiagnosticSeverity = "error" | "info" | "warning";

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

export interface ScanDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path?: string;
  readonly severity: ScanDiagnosticSeverity;
  readonly stage?: ScanStage;
}

export interface ScanLeaseSummary {
  readonly expiresAt: string;
  readonly heartbeatAt: string;
  readonly owner: string;
}

export interface ScanJobSnapshot extends ScanJobRequest {
  readonly attempt: number;
  readonly completedAt?: string;
  readonly completedStages: readonly ScanStage[];
  readonly counts?: Readonly<Record<string, number>>;
  readonly createdAt: string;
  readonly currentStage?: ScanStage;
  readonly degradedReasons: readonly string[];
  readonly diagnostics?: readonly ScanDiagnostic[];
  readonly dispatchMode?: IndexingDispatchMode;
  readonly dispatchState?: ScanDispatchState;
  readonly error?: ScanJobError;
  readonly id: string;
  readonly lease?: ScanLeaseSummary;
  readonly recoverableStage?: ScanStage;
  readonly stageTimings: Readonly<Partial<Record<ScanStage, ScanStageTiming>>>;
  readonly startedAt?: string;
  readonly state: ScanJobState;
  readonly updatedAt: string;
}

const identifierSchema = z.string().trim().min(1).max(256);
const timestampSchema = z.string().datetime({ offset: true });
const stageTimingSchema = z.object({
  completedAt: timestampSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  startedAt: timestampSchema,
});

export const scanJobRequestSchema = z.object({
  repositoryId: identifierSchema,
  revisionId: identifierSchema,
});

export const scanJobSnapshotSchema = scanJobRequestSchema
  .extend({
    attempt: z.number().int().nonnegative(),
    completedAt: timestampSchema.optional(),
    completedStages: z.array(scanStageSchema),
    counts: z.record(z.string(), z.number().int().nonnegative()).optional(),
    createdAt: timestampSchema,
    currentStage: scanStageSchema.optional(),
    degradedReasons: z.array(z.string()),
    diagnostics: z
      .array(
        z.object({
          code: z.string().trim().min(1),
          message: z.string().trim().min(1),
          path: z.string().trim().min(1).optional(),
          severity: z.enum(["error", "info", "warning"]),
          stage: scanStageSchema.optional(),
        }),
      )
      .optional(),
    dispatchMode: indexingDispatchModeSchema.optional(),
    dispatchState: scanDispatchStateSchema.optional(),
    error: z
      .object({
        message: z.string().trim().min(1),
        recoverable: z.boolean(),
        stage: scanStageSchema,
      })
      .optional(),
    id: identifierSchema,
    lease: z
      .object({
        expiresAt: timestampSchema,
        heartbeatAt: timestampSchema,
        owner: identifierSchema,
      })
      .optional(),
    recoverableStage: scanStageSchema.optional(),
    stageTimings: z.record(z.string(), stageTimingSchema),
    startedAt: timestampSchema.optional(),
    state: scanJobStateSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((snapshot, context) => {
    const completed = new Set(snapshot.completedStages);
    if (completed.size !== snapshot.completedStages.length) {
      context.addIssue({ code: "custom", message: "completedStages must not contain duplicates" });
    }
    for (const stage of Object.keys(snapshot.stageTimings)) {
      if (!SCAN_STAGES.includes(stage as ScanStage)) {
        context.addIssue({ code: "custom", message: `Unknown stage timing: ${stage}` });
      }
    }
    if (snapshot.currentStage !== undefined && completed.has(snapshot.currentStage)) {
      context.addIssue({ code: "custom", message: "currentStage cannot already be completed" });
    }
    if (snapshot.state === "RUNNING" && snapshot.currentStage === undefined) {
      context.addIssue({ code: "custom", message: "RUNNING scans require currentStage" });
    }
    if (snapshot.state !== "RUNNING" && snapshot.currentStage !== undefined) {
      context.addIssue({
        code: "custom",
        message: `${snapshot.state} scans cannot have currentStage`,
      });
    }
    if (snapshot.state === "COMPLETED" && snapshot.completedAt === undefined) {
      context.addIssue({ code: "custom", message: "COMPLETED scans require completedAt" });
    }
    if (snapshot.state === "FAILED" && snapshot.error === undefined) {
      context.addIssue({ code: "custom", message: "FAILED scans require error" });
    }
    if (snapshot.state !== "FAILED" && snapshot.error !== undefined) {
      context.addIssue({ code: "custom", message: `${snapshot.state} scans cannot have error` });
    }
    if (snapshot.recoverableStage !== undefined && snapshot.state !== "FAILED") {
      context.addIssue({
        code: "custom",
        message: "recoverableStage is only valid for FAILED scans",
      });
    }
    if (
      snapshot.lease !== undefined &&
      new Date(snapshot.lease.expiresAt).getTime() <= new Date(snapshot.lease.heartbeatAt).getTime()
    ) {
      context.addIssue({ code: "custom", message: "lease expiry must be after its heartbeat" });
    }
  });

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
  return isDegradableScanStage(stage);
}

export function isDegradableScanStage(stage: ScanStage): boolean {
  return stage === "EMBEDDING";
}

export function isPostActivationScanStage(stage: ScanStage): boolean {
  return stage === "PROJECTING_GRAPH" || stage === "EMBEDDING" || stage === "ANALYZING";
}
