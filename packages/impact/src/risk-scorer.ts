import type {
  AffectedSubgraph,
  RiskAssessment,
  RiskFactor,
  SemanticDiff,
  TestRecommendation,
} from "./impact-model.js";

export interface RiskScoringInput {
  readonly affected: AffectedSubgraph;
  readonly changedFileCount: number;
  readonly diff: SemanticDiff;
  readonly missingDocumentationCount?: number;
  readonly staleDocumentationCount?: number;
  readonly tests: readonly TestRecommendation[];
  readonly unresolvedRelationshipCount?: number;
}

function changedEntityText(diff: SemanticDiff): readonly string[] {
  return diff.entities.map((change) => JSON.stringify(change.after ?? change.before).toLowerCase());
}

function addFactor(
  factors: RiskFactor[],
  factor: string,
  weight: number,
  explanation: string,
  evidence: readonly string[],
): void {
  if (weight <= 0) return;
  factors.push({ evidence: [...evidence].sort(), explanation, factor, weight });
}

export function scoreRisk(input: RiskScoringInput): RiskAssessment {
  const factors: RiskFactor[] = [];
  const changed = changedEntityText(input.diff);
  const matching = (pattern: RegExp) =>
    input.diff.entities
      .filter((change, index) => pattern.test(changed[index] ?? ""))
      .map(({ stableKey }) => stableKey);
  const authentication = matching(/auth|security|jwt|token|permission|guard/u);
  addFactor(
    factors,
    "authentication-or-authorization",
    authentication.length > 0 ? 25 : 0,
    "Authentication or authorization behavior changed",
    authentication,
  );
  const endpoints = input.diff.entities
    .filter((change) => (change.after ?? change.before)?.kind === "endpoint")
    .map(({ stableKey }) => stableKey);
  addFactor(
    factors,
    "public-api",
    endpoints.length > 0 ? 20 : 0,
    "Public endpoint facts changed",
    endpoints,
  );
  const configuration = input.diff.entities
    .filter((change) =>
      ["configuration_key", "environment_variable"].includes(
        (change.after ?? change.before)?.kind ?? "",
      ),
    )
    .map(({ stableKey }) => stableKey);
  addFactor(
    factors,
    "configuration",
    configuration.length > 0 ? 12 : 0,
    "Runtime configuration changed",
    configuration,
  );
  const persistence = matching(/repository|database|persistence|mongo|postgres|sql/u);
  addFactor(
    factors,
    "persistence",
    persistence.length > 0 ? 15 : 0,
    "Persistence-layer behavior changed",
    persistence,
  );
  const downstream = input.affected.entities.filter(({ changeKind }) => changeKind === undefined);
  addFactor(
    factors,
    "downstream-impact",
    Math.min(15, Math.round(downstream.reduce((total, item) => total + item.confidence, 0))),
    `${downstream.length} downstream entities are affected`,
    downstream.map(({ entity }) => entity.stableKey),
  );
  addFactor(
    factors,
    "missing-tests",
    input.diff.entities.length > 0 && input.tests.length === 0 ? 15 : 0,
    "No relevant tests were found for changed entities",
    input.diff.entities.map(({ stableKey }) => stableKey),
  );
  const documentationCount =
    (input.missingDocumentationCount ?? 0) + (input.staleDocumentationCount ?? 0);
  addFactor(
    factors,
    "documentation-gap",
    Math.min(10, documentationCount * 5),
    "Changed behavior has missing or stale documentation",
    [`${documentationCount} documentation finding(s)`],
  );
  addFactor(
    factors,
    "unresolved-relationships",
    Math.min(8, (input.unresolvedRelationshipCount ?? 0) * 2),
    "Some changed relationships could not be resolved confidently",
    [`${input.unresolvedRelationshipCount ?? 0} unresolved relationship(s)`],
  );
  const changeSize =
    input.diff.entities.length + input.diff.relationships.length + input.changedFileCount;
  addFactor(
    factors,
    "change-size",
    Math.min(15, Math.floor(changeSize / 5) * 3),
    "The change spans multiple files or semantic facts",
    [
      `${input.changedFileCount} file(s), ${input.diff.entities.length + input.diff.relationships.length} fact change(s)`,
    ],
  );
  const score = Math.min(
    100,
    factors.reduce((total, { weight }) => total + weight, 0),
  );
  return {
    factors,
    level: score >= 55 ? "High" : score >= 25 ? "Medium" : "Low",
    score,
  };
}
