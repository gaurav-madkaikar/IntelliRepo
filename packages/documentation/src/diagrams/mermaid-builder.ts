import type {
  DocumentationEntity,
  DocumentationFactSnapshot,
  DocumentationRelationship,
} from "../documentation-model.js";

export interface MermaidDiagramData {
  readonly edges: readonly {
    readonly from: string;
    readonly label: string;
    readonly to: string;
  }[];
  readonly nodes: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly truncated: boolean;
}

function mermaidId(index: number): string {
  return `E${String(index + 1)}`;
}

function label(value: string): string {
  return value.replace(/["\n\r]/gu, "'").slice(0, 80);
}

export function buildMermaidData(
  snapshot: DocumentationFactSnapshot,
  selectedEntityKeys?: readonly string[],
  maximumRelationships = 30,
): MermaidDiagramData {
  const selected = selectedEntityKeys === undefined ? undefined : new Set(selectedEntityKeys);
  const canonical = snapshot.relationships
    .filter(
      (relationship) =>
        selected === undefined ||
        selected.has(relationship.sourceEntityKey) ||
        selected.has(relationship.targetEntityKey),
    )
    .sort(
      (left, right) =>
        left.sourceEntityKey.localeCompare(right.sourceEntityKey) ||
        left.kind.localeCompare(right.kind) ||
        left.targetEntityKey.localeCompare(right.targetEntityKey),
    );
  const relationships = canonical.slice(0, maximumRelationships);
  const keys = new Set(
    relationships.flatMap(({ sourceEntityKey, targetEntityKey }) => [
      sourceEntityKey,
      targetEntityKey,
    ]),
  );
  const entities = snapshot.entities
    .filter(({ stableKey }) => keys.has(stableKey))
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey));
  const ids = new Map(entities.map((entity, index) => [entity.stableKey, mermaidId(index)]));
  return {
    edges: relationships.flatMap((relationship) => {
      const from = ids.get(relationship.sourceEntityKey);
      const to = ids.get(relationship.targetEntityKey);
      return from === undefined || to === undefined ? [] : [{ from, label: relationship.kind, to }];
    }),
    nodes: entities.map((entity) => ({
      id: ids.get(entity.stableKey) as string,
      label: label(`${entity.kind}: ${entity.name}`),
    })),
    truncated: canonical.length > relationships.length,
  };
}

export function renderMermaidFlowchart(data: MermaidDiagramData): string {
  const lines = ["```mermaid", "flowchart TD"];
  for (const node of data.nodes) lines.push(`    ${node.id}["${node.label}"]`);
  for (const edge of data.edges)
    lines.push(`    ${edge.from} -->|${label(edge.label)}| ${edge.to}`);
  if (data.nodes.length === 0) lines.push('    EMPTY["No canonical relationships selected"]');
  lines.push("```");
  return lines.join("\n");
}

export function relationshipSource(
  relationship: DocumentationRelationship,
  entities: ReadonlyMap<string, DocumentationEntity>,
): string | undefined {
  return (
    relationship.sourceReference?.artifactPath ??
    entities.get(relationship.sourceEntityKey)?.source?.artifactPath
  );
}
