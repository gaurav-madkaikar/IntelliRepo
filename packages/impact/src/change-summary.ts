import type {
  AffectedSubgraph,
  RiskAssessment,
  SemanticDiff,
  SourceReference,
  TestRecommendation,
} from "./impact-model.js";

export interface BehaviorChange {
  readonly classification: "declared" | "inferred";
  readonly evidence: readonly SourceReference[];
  readonly statement: string;
}

export interface ChangeImpactReport {
  readonly affected: AffectedSubgraph;
  readonly affectedApis: readonly string[];
  readonly affectedDocumentation: readonly string[];
  readonly affectedModules: readonly string[];
  readonly baseRevisionId: string;
  readonly behaviorChanges: readonly BehaviorChange[];
  readonly changedFiles: readonly string[];
  readonly diff: SemanticDiff;
  readonly repositoryId: string;
  readonly reviewFocus: readonly string[];
  readonly risk: RiskAssessment;
  readonly targetRevisionId: string;
  readonly tests: readonly TestRecommendation[];
}

export interface AssembleChangeSummaryInput {
  readonly affected: AffectedSubgraph;
  readonly behaviorChanges?: readonly BehaviorChange[];
  readonly changedFiles: readonly string[];
  readonly diff: SemanticDiff;
  readonly risk: RiskAssessment;
  readonly tests: readonly TestRecommendation[];
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function assembleChangeSummary(input: AssembleChangeSummaryInput): ChangeImpactReport {
  const byKind = (kinds: readonly string[]) =>
    uniqueSorted(
      input.affected.entities
        .filter(({ entity }) => kinds.includes(entity.kind))
        .map(({ entity }) => entity.stableKey),
    );
  return {
    affected: input.affected,
    affectedApis: byKind(["endpoint"]),
    affectedDocumentation: byKind(["documentation_page", "documentation_section"]),
    affectedModules: byKind(["module", "package"]),
    baseRevisionId: input.diff.baseRevisionId,
    behaviorChanges: [...(input.behaviorChanges ?? [])].sort((left, right) =>
      left.statement.localeCompare(right.statement),
    ),
    changedFiles: uniqueSorted(input.changedFiles),
    diff: input.diff,
    repositoryId: input.diff.repositoryId,
    reviewFocus: [...input.risk.factors]
      .sort((left, right) => right.weight - left.weight || left.factor.localeCompare(right.factor))
      .slice(0, 5)
      .map(({ explanation }) => explanation),
    risk: input.risk,
    targetRevisionId: input.diff.targetRevisionId,
    tests: input.tests,
  };
}

function section(title: string, entries: readonly string[]): string[] {
  return [`## ${title}`, "", ...(entries.length === 0 ? ["_None._"] : entries), ""];
}

function source(reference: SourceReference | undefined): string {
  if (reference === undefined) return "inference path retained in structured report";
  const lines =
    reference.startLine === undefined
      ? ""
      : `:${reference.startLine}${reference.endLine === undefined ? "" : `-${reference.endLine}`}`;
  return `${reference.artifactPath}${lines}`;
}

export function renderChangeSummaryMarkdown(report: ChangeImpactReport): string {
  const changedEntities = report.diff.entities.map((change) => {
    const entity = change.after ?? change.before;
    return `- **${change.kind}** \`${change.stableKey}\`${change.changedFields.length === 0 ? "" : ` (${change.changedFields.join(", ")})`} — ${source(entity?.source)}`;
  });
  const behavior = report.behaviorChanges.map(
    (change) =>
      `- **${change.classification === "inferred" ? "Inferred" : "Declared"}:** ${change.statement}${change.evidence.length === 0 ? "" : ` — ${change.evidence.map(source).join(", ")}`}`,
  );
  const tests = report.tests.map(
    (test) =>
      `- \`${test.testEntity.stableKey}\` — ${test.reason} (${test.score.toFixed(2)}, ${test.confidence.level})`,
  );
  const factors = report.risk.factors.map(
    ({ explanation, factor, weight }) => `- **${factor} (+${weight}):** ${explanation}`,
  );
  const traversal = report.affected.traversal;
  return [
    "# IntelliRepo Change Impact",
    "",
    `- Repository: \`${report.repositoryId}\``,
    `- Revisions: \`${report.baseRevisionId}\` → \`${report.targetRevisionId}\``,
    `- Risk: **${report.risk.level} (${report.risk.score}/100)**`,
    `- Traversal: ${traversal?.adapter ?? "not required"}${traversal?.degradedReason === undefined ? "" : ` — degraded: ${traversal.degradedReason}`}`,
    `- Result truncated: ${report.affected.truncated ? "yes" : "no"}`,
    "",
    ...section(
      "Changed files",
      report.changedFiles.map((path) => `- \`${path}\``),
    ),
    ...section("Semantic changes", changedEntities),
    ...section("Behavior changes", behavior),
    ...section(
      "Affected APIs",
      report.affectedApis.map((key) => `- \`${key}\``),
    ),
    ...section(
      "Affected modules",
      report.affectedModules.map((key) => `- \`${key}\``),
    ),
    ...section(
      "Affected documentation",
      report.affectedDocumentation.map((key) => `- \`${key}\``),
    ),
    ...section("Suggested tests", tests),
    ...section("Risk factors", factors),
    ...section(
      "Suggested review focus",
      report.reviewFocus.map((focus) => `- ${focus}`),
    ),
  ].join("\n");
}
