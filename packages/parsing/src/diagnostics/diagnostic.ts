import type { EntityStableKey, SourceRange } from "@intellirepo/domain";

export const DIAGNOSTIC_SEVERITIES = ["error", "warning", "information"] as const;

export type DiagnosticSeverity = (typeof DIAGNOSTIC_SEVERITIES)[number];

export interface ExtractionDiagnostic {
  readonly artifactPath: string;
  readonly candidateEntityKeys?: readonly EntityStableKey[];
  readonly code: string;
  readonly message: string;
  readonly range?: SourceRange;
  readonly severity: DiagnosticSeverity;
}

export function createDiagnostic(diagnostic: ExtractionDiagnostic): ExtractionDiagnostic {
  const code = diagnostic.code.trim();
  const message = diagnostic.message.trim();
  const artifactPath = diagnostic.artifactPath.trim().replaceAll("\\", "/");

  if (code.length === 0 || message.length === 0 || artifactPath.length === 0) {
    throw new Error("Diagnostic code, message, and artifactPath must not be empty");
  }

  return Object.freeze({
    artifactPath,
    ...(diagnostic.candidateEntityKeys === undefined
      ? {}
      : { candidateEntityKeys: Object.freeze([...diagnostic.candidateEntityKeys]) }),
    code,
    message,
    ...(diagnostic.range === undefined ? {} : { range: diagnostic.range }),
    severity: diagnostic.severity,
  });
}
