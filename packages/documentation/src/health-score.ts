import type {
  DocumentationFinding,
  DocumentationGap,
  DocumentationHealth,
} from "./documentation-model.js";

const SEVERITY_PENALTY = {
  high: 15,
  informational: 1,
  low: 3,
  medium: 8,
} as const;

/**
 * Health is deterministic: 100 minus finding penalties, one point per gap, and up to
 * twenty points for incomplete indexing. Review candidates are informational only.
 */
export function calculateDocumentationHealth(
  findings: readonly DocumentationFinding[],
  gaps: readonly DocumentationGap[],
  indexingCompleteness = 1,
): DocumentationHealth {
  const completeness = Math.max(0, Math.min(1, indexingCompleteness));
  const confirmed = findings.filter(({ status }) => status === "confirmed");
  const counts = {
    high: findings.filter(({ severity }) => severity === "high").length,
    informational: findings.filter(({ severity }) => severity === "informational").length,
    low: findings.filter(({ severity }) => severity === "low").length,
    medium: findings.filter(({ severity }) => severity === "medium").length,
  };
  const findingPenalty = Object.entries(counts).reduce(
    (total, [severity, count]) =>
      total + SEVERITY_PENALTY[severity as keyof typeof SEVERITY_PENALTY] * count,
    0,
  );
  const completenessPenalty = Math.round((1 - completeness) * 20);
  const score = Math.max(
    0,
    Math.min(100, 100 - findingPenalty - gaps.length - completenessPenalty),
  );
  return {
    explanation: `100 - ${findingPenalty} finding penalty - ${gaps.length} gap penalty - ${completenessPenalty} indexing penalty = ${score}`,
    metrics: {
      confirmedFindings: confirmed.length,
      gaps: gaps.length,
      ...counts,
      indexingCompleteness: completeness,
      reviewCandidates: findings.length - confirmed.length,
    },
    score,
  };
}
