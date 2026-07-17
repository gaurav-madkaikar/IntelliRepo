import type {
  AffectedSubgraph,
  SemanticDiff,
  SnapshotEntity,
  TestRecommendation,
} from "./impact-model.js";

function normalized(value: string): string {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/gu, "")
    .replace(/tests?$/u, "");
}

export function recommendTests(
  diff: SemanticDiff,
  affected: AffectedSubgraph,
  candidateTests: readonly SnapshotEntity[] = [],
): readonly TestRecommendation[] {
  const changedNames = diff.entities
    .map((change) => change.after?.name ?? change.before?.name)
    .filter((name): name is string => name !== undefined)
    .map(normalized);
  const affectedTests = new Map(
    affected.entities
      .filter(({ changeKind, entity }) => entity.kind === "test" && changeKind !== "removed")
      .map((candidate) => [candidate.entity.stableKey, candidate]),
  );
  const tests = new Map(
    [
      ...candidateTests.filter(({ kind }) => kind === "test"),
      ...[...affectedTests.values()].map(({ entity }) => entity),
    ].map((entity) => [entity.stableKey, entity]),
  );
  return [...tests.values()]
    .flatMap((testEntity): readonly TestRecommendation[] => {
      const candidate = affectedTests.get(testEntity.stableKey);
      const evidencePath = candidate?.evidencePath ?? [];
      const kinds = evidencePath.map(({ relationshipKind }) => relationshipKind);
      const directTest = evidencePath.length === 1 && kinds.includes("TESTS");
      const endpointCoverage = kinds.includes("TESTS") && kinds.includes("HANDLES");
      const structural = kinds.some((kind) => kind === "CALLS" || kind === "IMPORTS");
      const naming = changedNames.some(
        (name) => name.length > 0 && normalized(testEntity.name).includes(name),
      );
      if (candidate === undefined && !naming) return [];
      const baseScore = directTest
        ? 0.98
        : endpointCoverage
          ? 0.9
          : structural
            ? 0.78
            : naming
              ? 0.55
              : Math.max(0.5, candidate?.confidence ?? 0);
      const score = Math.min(baseScore, candidate?.confidence ?? 0.55);
      const reason = directTest
        ? "Direct TESTS relationship to a changed entity"
        : endpointCoverage
          ? "Covers an endpoint connected to a changed entity"
          : structural
            ? "Calls or imports an affected code path"
            : naming
              ? "Test name matches a changed entity"
              : "Connected through the bounded affected subgraph";
      const level = score >= 0.95 ? "confirmed" : score >= 0.5 ? "inferred" : "tentative";
      return [
        {
          confidence: { level, reason, score },
          evidencePath,
          reason,
          score,
          testEntity,
        },
      ];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.testEntity.stableKey.localeCompare(right.testEntity.stableKey),
    );
}
