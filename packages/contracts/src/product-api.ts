import { z } from "zod";

import type {
  IndexingDispatchMode,
  ScanDispatchState,
  ScanJobState,
  ScanStage,
} from "./jobs/scan-job.js";

const identifier = z.string().trim().min(1).max(256);
const positiveLimit = z.coerce.number().int().min(1);

export const repositoryIdSchema = identifier;
export const revisionIdSchema = identifier;

export const registerRepositorySchema = z.object({
  rootPath: z.string().trim().min(1).max(4_096),
});

export const triggerScanSchema = z.object({
  commitSha: z.string().trim().min(1).max(128).default("WORKTREE"),
  worktreeFingerprint: z.string().trim().min(1).max(256),
});

export const entitySearchSchema = z.object({
  kind: z.string().trim().min(1).max(128).optional(),
  limit: positiveLimit.max(100).default(25),
  query: z.string().trim().min(1).max(512),
  revisionId: revisionIdSchema.optional(),
});

export const graphNeighborhoodSchema = z.object({
  direction: z.enum(["both", "incoming", "outgoing"]).default("both"),
  maxDepth: positiveLimit.max(10).default(3),
  maxNodes: positiveLimit.max(1_000).default(200),
  mode: z.enum(["affected-subgraph", "endpoint-flow", "neighborhood"]).default("neighborhood"),
  relationshipKinds: z.array(identifier).max(25).default([]),
  revisionId: revisionIdSchema.optional(),
  startEntityKeys: z.array(identifier).min(1).max(25),
});

export const revisionPairSchema = z.object({
  baseRevisionId: revisionIdSchema,
  targetRevisionId: revisionIdSchema,
});

export const documentationHealthQuerySchema = z.object({
  revisionId: revisionIdSchema.optional(),
  severity: z.enum(["critical", "high", "medium", "low"]).optional(),
  status: z.enum(["confirmed", "dismissed", "open", "resolved"]).optional(),
});

export const documentationPreviewSchema = z.object({
  entityKeys: z.array(identifier).max(100).optional(),
  kind: z.enum(["api", "architecture", "change", "configuration", "module", "onboarding"]),
  revisionId: revisionIdSchema.optional(),
  targetPath: z.string().trim().min(1).max(4_096).optional(),
  title: z.string().trim().min(1).max(200),
});

export const documentationApplySchema = z.object({
  accepted: z.literal(true),
});

export const askQuestionSchema = z.object({
  question: z.string().trim().min(3).max(2_000),
  revisionId: revisionIdSchema.optional(),
});

export type RegisterRepositoryRequest = z.infer<typeof registerRepositorySchema>;
export type TriggerScanRequest = z.infer<typeof triggerScanSchema>;
export type EntitySearchRequest = z.infer<typeof entitySearchSchema>;
export type GraphNeighborhoodRequest = z.infer<typeof graphNeighborhoodSchema>;
export type RevisionPairRequest = z.infer<typeof revisionPairSchema>;
export type DocumentationHealthQuery = z.infer<typeof documentationHealthQuerySchema>;
export type DocumentationPreviewRequest = z.infer<typeof documentationPreviewSchema>;
export type DocumentationApplyRequest = z.infer<typeof documentationApplySchema>;
export type AskQuestionRequest = z.infer<typeof askQuestionSchema>;

export type CapabilityState = "current" | "degraded" | "disabled" | "failed" | "stale";

export interface CapabilityStatus {
  readonly detail: string;
  readonly lagRevisions: number;
  readonly projectedRevisionId?: string;
  readonly state: CapabilityState;
}

export interface RepositoryOverviewResponse {
  readonly capabilities: {
    readonly analysis: CapabilityStatus;
    readonly canonical: CapabilityStatus;
    readonly ollama: CapabilityStatus;
    readonly semantic: CapabilityStatus;
    readonly worker: WorkerCapabilityStatus;
  };
  readonly counts: Readonly<Record<string, number>>;
  readonly documentationHealth?: {
    readonly explanation: string;
    readonly score: number;
  };
  readonly latestJob?: ScanJobSummary;
  readonly repository: RepositorySummary;
  readonly revision?: RevisionSummary;
  readonly selectedTraversalAdapter: "postgresql";
}

export interface WorkerCapabilityStatus extends CapabilityStatus {
  readonly dispatchMode: IndexingDispatchMode;
}

export interface RepositorySummary {
  readonly defaultBranch?: string;
  readonly displayName: string;
  readonly id: string;
  readonly rootPath: string;
}

export interface RevisionSummary {
  readonly commitSha: string;
  readonly createdAt: string;
  readonly id: string;
  readonly status: string;
}

export interface ScanJobSummary {
  readonly attempt: number;
  readonly currentStage?: ScanStage;
  readonly degradedReasons: readonly string[];
  readonly dispatchMode?: IndexingDispatchMode;
  readonly dispatchState?: ScanDispatchState;
  readonly id: string;
  readonly revisionId: string;
  readonly state: ScanJobState;
  readonly updatedAt: string;
}

export interface GraphNodeResponse {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly qualifiedName?: string;
  readonly stableKey: string;
}

export interface GraphEdgeResponse {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly id: string;
  readonly kind: string;
  readonly sourceId: string;
  readonly targetId: string;
}

export interface GraphNeighborhoodResponse {
  readonly adapter: "postgresql";
  readonly edges: readonly GraphEdgeResponse[];
  readonly missingStartEntityKeys: readonly string[];
  readonly nodes: readonly GraphNodeResponse[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly truncated: boolean;
}

export interface ImpactSourceReferenceResponse {
  readonly artifactPath: string;
  readonly endLine?: number;
  readonly evidence: string;
  readonly startLine?: number;
}

export interface ImpactTestRecommendationResponse {
  readonly confidence: {
    readonly level: "confirmed" | "inferred" | "tentative";
    readonly reason: string;
    readonly score: number;
  };
  readonly reason: string;
  readonly score: number;
  readonly testEntity: {
    readonly kind: string;
    readonly name: string;
    readonly source?: ImpactSourceReferenceResponse;
    readonly stableKey: string;
  };
}

export interface ChangeImpactResponse {
  readonly affected: {
    readonly truncated: boolean;
  };
  readonly affectedApis: readonly string[];
  readonly affectedDocumentation: readonly string[];
  readonly affectedModules: readonly string[];
  readonly baseRevisionId: string;
  readonly changedFiles: readonly string[];
  readonly generatedAt: string;
  readonly markdown: string;
  readonly repositoryId: string;
  readonly reviewFocus: readonly string[];
  readonly risk: {
    readonly factors: readonly {
      readonly evidence: readonly string[];
      readonly explanation: string;
      readonly factor: string;
      readonly weight: number;
    }[];
    readonly level: "High" | "Low" | "Medium";
    readonly score: number;
  };
  readonly targetRevisionId: string;
  readonly tests: readonly ImpactTestRecommendationResponse[];
}

export interface DocumentationReviewResponse {
  readonly diff: string;
  readonly enhancement: {
    readonly reason?: string;
    readonly state: "applied" | "degraded" | "disabled";
  };
  readonly id: string;
  readonly manifest: {
    readonly entityKeys: readonly string[];
    readonly generatedBy: "IntelliRepo";
    readonly kind: DocumentationPreviewRequest["kind"];
    readonly relationshipIds: readonly string[];
    readonly repositoryId: string;
    readonly revisionId: string;
    readonly sourceReferences: readonly string[];
  };
  readonly originalChecksum: string;
  readonly path: string;
  readonly proposedMarkdown: string;
  readonly repositoryId: string;
  readonly revisionId: string;
}

export interface EntitySearchResult {
  readonly items: readonly {
    readonly id: string;
    readonly kind: string;
    readonly language?: string;
    readonly name: string;
    readonly path?: string;
    readonly qualifiedName?: string;
    readonly stableKey: string;
  }[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly total: number;
}

export interface DocumentationHealthResponse {
  readonly explanation: string;
  readonly findings: readonly {
    readonly evidence: Readonly<Record<string, unknown>>;
    readonly id: string;
    readonly kind: string;
    readonly severity: string;
    readonly status: string;
  }[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly score: number;
}

export type AsyncTaskState = "failed" | "queued" | "running" | "succeeded";

export interface QuestionTaskResponse<TAnswer = unknown> {
  readonly error?: string;
  readonly id: string;
  readonly result?: TAnswer;
  readonly state: AsyncTaskState;
  readonly updatedAt: string;
}
