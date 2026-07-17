import type { GraphTraversal, TraversalResult } from "@intellirepo/graph";

import type {
  AffectedEntity,
  AffectedSubgraph,
  ChangeKind,
  EvidenceStep,
  FactSnapshot,
  SemanticDiff,
  SnapshotEntity,
  SnapshotRelationship,
} from "./impact-model.js";
import {
  DEFAULT_TRAVERSAL_RULES,
  relationshipConfidenceMultiplier,
  type TraversalRule,
} from "./traversal-rules.js";

export interface AffectedSubgraphOptions {
  readonly maxDepth?: number;
  readonly maxFanOut?: number;
  readonly maxNodes?: number;
  readonly minimumConfidence?: number;
  readonly rules?: readonly TraversalRule[];
}

interface PropagationGraph {
  readonly entities: ReadonlyMap<string, SnapshotEntity>;
  readonly relationships: readonly SnapshotRelationship[];
  readonly sourceRevision: "base" | "target";
}

interface Candidate {
  readonly changeKind?: ChangeKind;
  readonly confidence: number;
  readonly entityKey: string;
  readonly evidencePath: readonly EvidenceStep[];
  readonly reason: string;
}

function rootChanges(diff: SemanticDiff): Map<string, ChangeKind> {
  const roots = new Map(diff.entities.map((change) => [change.stableKey, change.kind]));
  const removedEntityKeys = new Set(
    diff.entities.filter(({ kind }) => kind === "removed").map(({ stableKey }) => stableKey),
  );
  for (const change of diff.relationships) {
    const relationship = change.after ?? change.before;
    if (relationship === undefined) continue;
    if (
      change.kind === "removed" &&
      (removedEntityKeys.has(relationship.sourceEntityKey) ||
        removedEntityKeys.has(relationship.targetEntityKey))
    ) {
      continue;
    }
    if (!roots.has(relationship.sourceEntityKey))
      roots.set(relationship.sourceEntityKey, change.kind);
    if (!roots.has(relationship.targetEntityKey))
      roots.set(relationship.targetEntityKey, change.kind);
  }
  return roots;
}

function targetGraph(
  snapshot: FactSnapshot,
  traversal: TraversalResult | undefined,
): PropagationGraph {
  if (traversal === undefined) {
    return { entities: new Map(), relationships: [], sourceRevision: "target" };
  }
  const allowedNodeIds = new Set(traversal.nodes.map(({ id }) => id));
  const allowedEdgeIds = new Set(traversal.edges.map(({ id }) => id));
  const snapshotById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const snapshotIdByKey = new Map(snapshot.entities.map((entity) => [entity.stableKey, entity.id]));
  const entities = new Map<string, SnapshotEntity>();
  for (const node of traversal.nodes) {
    const entity = snapshotById.get(node.id) ?? {
      attributes: node.attributes,
      id: node.id,
      kind: node.kind,
      name: node.name,
      ...(node.qualifiedName === undefined ? {} : { qualifiedName: node.qualifiedName }),
      stableKey: node.stableKey,
    };
    entities.set(entity.stableKey, entity);
  }
  const relationships = snapshot.relationships.filter(
    (relationship) =>
      allowedEdgeIds.has(relationship.id) &&
      allowedNodeIds.has(snapshotIdByKey.get(relationship.sourceEntityKey) ?? "") &&
      allowedNodeIds.has(snapshotIdByKey.get(relationship.targetEntityKey) ?? ""),
  );
  return { entities, relationships, sourceRevision: "target" };
}

function baseGraph(snapshot: FactSnapshot): PropagationGraph {
  return {
    entities: new Map(snapshot.entities.map((entity) => [entity.stableKey, entity])),
    relationships: snapshot.relationships,
    sourceRevision: "base",
  };
}

function propagate(
  graph: PropagationGraph,
  roots: ReadonlyMap<string, ChangeKind>,
  options: Required<Omit<AffectedSubgraphOptions, "rules">> & {
    readonly rules: readonly TraversalRule[];
  },
): { readonly affected: ReadonlyMap<string, Candidate>; readonly truncated: boolean } {
  const ruleByKind = new Map(options.rules.map((rule) => [rule.kind, rule]));
  const adjacent = new Map<string, SnapshotRelationship[]>();
  for (const relationship of graph.relationships) {
    for (const key of [relationship.sourceEntityKey, relationship.targetEntityKey]) {
      adjacent.set(key, [...(adjacent.get(key) ?? []), relationship]);
    }
  }
  const affected = new Map<string, Candidate>();
  const queue: Candidate[] = [];
  for (const [entityKey, changeKind] of [...roots].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!graph.entities.has(entityKey)) continue;
    const candidate: Candidate = {
      changeKind,
      confidence: 1,
      entityKey,
      evidencePath: [],
      reason: `${changeKind} semantic fact`,
    };
    affected.set(entityKey, candidate);
    queue.push(candidate);
  }

  let truncated = false;
  while (queue.length > 0) {
    queue.sort(
      (left, right) =>
        right.confidence - left.confidence || left.entityKey.localeCompare(right.entityKey),
    );
    const current = queue.shift();
    if (current === undefined || current.evidencePath.length >= options.maxDepth) continue;
    const eligible = (adjacent.get(current.entityKey) ?? [])
      .flatMap((relationship) => {
        const rule = ruleByKind.get(relationship.kind);
        if (rule === undefined) return [];
        const outgoing = relationship.sourceEntityKey === current.entityKey;
        const toEntityKey = outgoing ? relationship.targetEntityKey : relationship.sourceEntityKey;
        const weight =
          (outgoing ? rule.outgoing : rule.incoming) *
          relationshipConfidenceMultiplier(relationship);
        return [{ outgoing, relationship, rule, toEntityKey, weight }];
      })
      .filter(({ weight }) => weight > 0)
      .sort(
        (left, right) =>
          right.weight - left.weight || left.relationship.id.localeCompare(right.relationship.id),
      );
    if (eligible.length > options.maxFanOut) truncated = true;
    for (const step of eligible.slice(0, options.maxFanOut)) {
      if (!graph.entities.has(step.toEntityKey)) continue;
      const confidence = current.confidence * step.weight;
      if (confidence < options.minimumConfidence) continue;
      const previous = affected.get(step.toEntityKey);
      if (previous !== undefined && previous.confidence >= confidence) continue;
      if (previous === undefined && affected.size >= options.maxNodes) {
        truncated = true;
        continue;
      }
      const evidence: EvidenceStep = {
        direction: step.outgoing ? "outgoing" : "incoming",
        fromEntityKey: current.entityKey,
        relationshipId: step.relationship.id,
        relationshipKind: step.relationship.kind,
        sourceRevision: graph.sourceRevision,
        toEntityKey: step.toEntityKey,
        weight: step.weight,
      };
      const candidate: Candidate = {
        confidence,
        entityKey: step.toEntityKey,
        evidencePath: [...current.evidencePath, evidence],
        reason: `Reached through ${step.rule.reason}`,
      };
      affected.set(step.toEntityKey, candidate);
      queue.push(candidate);
    }
  }
  return { affected, truncated };
}

function mergeAffected(
  target: ReadonlyMap<string, Candidate>,
  base: ReadonlyMap<string, Candidate>,
): ReadonlyMap<string, Candidate> {
  const merged = new Map(target);
  for (const [key, candidate] of base) {
    const existing = merged.get(key);
    if (existing === undefined || candidate.confidence > existing.confidence)
      merged.set(key, candidate);
  }
  return merged;
}

export class AffectedSubgraphCalculator {
  public constructor(private readonly traversal: GraphTraversal) {}

  public async calculate(
    diff: SemanticDiff,
    base: FactSnapshot,
    target: FactSnapshot,
    inputOptions: AffectedSubgraphOptions = {},
  ): Promise<AffectedSubgraph> {
    const options = {
      maxDepth: inputOptions.maxDepth ?? 4,
      maxFanOut: inputOptions.maxFanOut ?? 25,
      maxNodes: inputOptions.maxNodes ?? 200,
      minimumConfidence: inputOptions.minimumConfidence ?? 0.2,
      rules: inputOptions.rules ?? DEFAULT_TRAVERSAL_RULES,
    };
    const roots = rootChanges(diff);
    const targetEntityKeys = new Set(target.entities.map(({ stableKey }) => stableKey));
    const targetRoots = [...roots.keys()].filter((key) => targetEntityKeys.has(key));
    const traversalResult =
      targetRoots.length === 0
        ? undefined
        : await this.traversal.traverse({
            direction: "both",
            maxDepth: options.maxDepth,
            maxNodes: Math.min(1_000, options.maxNodes * 2),
            mode: "affected-subgraph",
            repositoryId: target.repositoryId,
            revisionId: target.revisionId,
            startEntityKeys: targetRoots,
          });
    const targetPropagation = propagate(targetGraph(target, traversalResult), roots, options);
    const removedRoots = new Map([...roots].filter(([, kind]) => kind === "removed"));
    const basePropagation = propagate(baseGraph(base), removedRoots, options);
    const merged = mergeAffected(targetPropagation.affected, basePropagation.affected);
    const baseEntities = new Map(base.entities.map((entity) => [entity.stableKey, entity]));
    const targetEntities = new Map(target.entities.map((entity) => [entity.stableKey, entity]));
    const entities: AffectedEntity[] = [...merged.values()]
      .sort(
        (left, right) =>
          right.confidence - left.confidence || left.entityKey.localeCompare(right.entityKey),
      )
      .map((candidate) => ({
        ...(candidate.changeKind === undefined ? {} : { changeKind: candidate.changeKind }),
        confidence: candidate.confidence,
        entity:
          targetEntities.get(candidate.entityKey) ??
          baseEntities.get(candidate.entityKey) ??
          (() => {
            throw new Error(
              `Affected entity ${candidate.entityKey} is missing from both snapshots`,
            );
          })(),
        evidencePath: candidate.evidencePath,
        reason: candidate.reason,
      }));
    return {
      entities,
      repositoryId: target.repositoryId,
      revisionId: target.revisionId,
      truncated:
        targetPropagation.truncated ||
        basePropagation.truncated ||
        (traversalResult?.truncated ?? false),
      ...(traversalResult === undefined
        ? {}
        : {
            traversal: {
              adapter: traversalResult.adapter,
              ...(traversalResult.projection.degradedReason === undefined
                ? {}
                : { degradedReason: traversalResult.projection.degradedReason }),
            },
          }),
    };
  }
}
