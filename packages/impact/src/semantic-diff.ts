import type {
  ChangeKind,
  EntityChange,
  FactSnapshot,
  RelationshipChange,
  SemanticDiff,
  SnapshotRelationship,
} from "./impact-model.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function changedFields(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): readonly string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .filter((field) => canonical(before[field]) !== canonical(after[field]));
}

export function relationshipIdentity(relationship: SnapshotRelationship): string {
  return [relationship.kind, relationship.sourceEntityKey, relationship.targetEntityKey].join("|");
}

function relationshipIndex(
  relationships: readonly SnapshotRelationship[],
): ReadonlyMap<string, SnapshotRelationship> {
  const strongestFirst = [...relationships].sort(
    (left, right) =>
      (right.confidence ?? 1) - (left.confidence ?? 1) ||
      canonical(left.attributes).localeCompare(canonical(right.attributes)) ||
      left.id.localeCompare(right.id),
  );
  const indexed = new Map<string, SnapshotRelationship>();
  for (const relationship of strongestFirst) {
    const identity = relationshipIdentity(relationship);
    if (!indexed.has(identity)) indexed.set(identity, relationship);
  }
  return indexed;
}

function entityChanges(base: FactSnapshot, target: FactSnapshot): readonly EntityChange[] {
  const beforeByKey = new Map(base.entities.map((entity) => [entity.stableKey, entity]));
  const afterByKey = new Map(target.entities.map((entity) => [entity.stableKey, entity]));
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  return keys.flatMap((stableKey): readonly EntityChange[] => {
    const before = beforeByKey.get(stableKey);
    const after = afterByKey.get(stableKey);
    if (before === undefined && after !== undefined) {
      return [{ after, changedFields: [], kind: "added" as const, stableKey }];
    }
    if (before !== undefined && after === undefined) {
      return [{ before, changedFields: [], kind: "removed" as const, stableKey }];
    }
    if (before === undefined || after === undefined) return [];
    const materialFields = changedFields(
      {
        attributes: before.attributes,
        kind: before.kind,
        language: before.language,
        name: before.name,
        qualifiedName: before.qualifiedName,
      },
      {
        attributes: after.attributes,
        kind: after.kind,
        language: after.language,
        name: after.name,
        qualifiedName: after.qualifiedName,
      },
    );
    return materialFields.length === 0
      ? []
      : [{ after, before, changedFields: materialFields, kind: "modified" as const, stableKey }];
  });
}

function relationshipChanges(
  base: FactSnapshot,
  target: FactSnapshot,
): readonly RelationshipChange[] {
  const beforeByKey = relationshipIndex(base.relationships);
  const afterByKey = relationshipIndex(target.relationships);
  const keys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  return keys.flatMap((identity): readonly RelationshipChange[] => {
    const before = beforeByKey.get(identity);
    const after = afterByKey.get(identity);
    if (before === undefined && after !== undefined) {
      return [{ after, changedFields: [], identity, kind: "added" as const }];
    }
    if (before !== undefined && after === undefined) {
      return [{ before, changedFields: [], identity, kind: "removed" as const }];
    }
    if (before === undefined || after === undefined) return [];
    const materialFields = changedFields(
      { attributes: before.attributes, confidence: before.confidence },
      { attributes: after.attributes, confidence: after.confidence },
    );
    return materialFields.length === 0
      ? []
      : [{ after, before, changedFields: materialFields, identity, kind: "modified" as const }];
  });
}

export function calculateSemanticDiff(base: FactSnapshot, target: FactSnapshot): SemanticDiff {
  if (base.repositoryId !== target.repositoryId) {
    throw new Error("Semantic diff snapshots must belong to the same repository");
  }
  const entities = entityChanges(base, target);
  const relationships = relationshipChanges(base, target);
  const allChanges: readonly { readonly kind: ChangeKind }[] = [...entities, ...relationships];
  const count = (kind: ChangeKind) => allChanges.filter((change) => change.kind === kind).length;
  return {
    baseRevisionId: base.revisionId,
    entities,
    relationships,
    repositoryId: base.repositoryId,
    summary: { added: count("added"), modified: count("modified"), removed: count("removed") },
    targetRevisionId: target.revisionId,
  };
}
