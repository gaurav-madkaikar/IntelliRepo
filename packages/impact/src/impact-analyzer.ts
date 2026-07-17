import type { GraphTraversal } from "@intellirepo/graph";

import { AffectedSubgraphCalculator, type AffectedSubgraphOptions } from "./affected-subgraph.js";
import {
  assembleChangeSummary,
  type BehaviorChange,
  type ChangeImpactReport,
} from "./change-summary.js";
import type { FactSnapshot } from "./impact-model.js";
import { scoreRisk } from "./risk-scorer.js";
import { calculateSemanticDiff } from "./semantic-diff.js";
import { recommendTests } from "./test-recommender.js";

export interface AnalyzeImpactInput {
  readonly base: FactSnapshot;
  readonly behaviorChanges?: readonly BehaviorChange[];
  readonly changedFiles: readonly string[];
  readonly missingDocumentationCount?: number;
  readonly staleDocumentationCount?: number;
  readonly target: FactSnapshot;
  readonly traversal?: AffectedSubgraphOptions;
  readonly unresolvedRelationshipCount?: number;
}

/** Deep deterministic seam used by local changes and GitHub pull request analysis alike. */
export class ImpactAnalyzer {
  private readonly affected: AffectedSubgraphCalculator;

  public constructor(traversal: GraphTraversal) {
    this.affected = new AffectedSubgraphCalculator(traversal);
  }

  public async analyze(input: AnalyzeImpactInput): Promise<ChangeImpactReport> {
    const diff = calculateSemanticDiff(input.base, input.target);
    const affected = await this.affected.calculate(diff, input.base, input.target, input.traversal);
    const tests = recommendTests(
      diff,
      affected,
      input.target.entities.filter(({ kind }) => kind === "test"),
    );
    const risk = scoreRisk({
      affected,
      changedFileCount: input.changedFiles.length,
      diff,
      ...(input.missingDocumentationCount === undefined
        ? {}
        : { missingDocumentationCount: input.missingDocumentationCount }),
      ...(input.staleDocumentationCount === undefined
        ? {}
        : { staleDocumentationCount: input.staleDocumentationCount }),
      tests,
      ...(input.unresolvedRelationshipCount === undefined
        ? {}
        : { unresolvedRelationshipCount: input.unresolvedRelationshipCount }),
    });
    return assembleChangeSummary({
      affected,
      ...(input.behaviorChanges === undefined ? {} : { behaviorChanges: input.behaviorChanges }),
      changedFiles: input.changedFiles,
      diff,
      risk,
      tests,
    });
  }
}
