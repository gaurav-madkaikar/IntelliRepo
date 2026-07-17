import type { DocumentationEntity, DocumentationFactSnapshot } from "../documentation-model.js";
import { buildMermaidData, renderMermaidFlowchart } from "../diagrams/mermaid-builder.js";

export type DocumentationKind =
  "api" | "architecture" | "change" | "configuration" | "module" | "onboarding";

function stringAttribute(entity: DocumentationEntity, name: string): string | undefined {
  const value = entity.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function selectedEntities(
  snapshot: DocumentationFactSnapshot,
  entityKeys?: readonly string[],
): readonly DocumentationEntity[] {
  const keys = entityKeys === undefined ? undefined : new Set(entityKeys);
  return snapshot.entities
    .filter((entity) => keys === undefined || keys.has(entity.stableKey))
    .sort(
      (left, right) => left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name),
    );
}

function endpointFacts(entities: readonly DocumentationEntity[]): string {
  const endpoints = entities.filter(({ kind }) => kind === "endpoint");
  if (endpoints.length === 0) return "- No endpoint facts selected.";
  return endpoints
    .map((entity) => {
      const method = stringAttribute(entity, "httpMethod") ?? "UNKNOWN";
      const path = stringAttribute(entity, "normalizedPath") ?? entity.name;
      const request = stringAttribute(entity, "requestType");
      const response = stringAttribute(entity, "responseType");
      const types = [
        request === undefined ? undefined : `request: ${request}`,
        response === undefined ? undefined : `response: ${response}`,
      ]
        .filter((value): value is string => value !== undefined)
        .join(", ");
      return `- \`${method} ${path}\`${types.length === 0 ? "" : ` — ${types}`}`;
    })
    .join("\n");
}

function configurationFacts(entities: readonly DocumentationEntity[]): string {
  const configuration = entities.filter(({ kind }) => kind === "configuration_key");
  if (configuration.length === 0) return "- No configuration facts selected.";
  return configuration
    .map((entity) => {
      const key = stringAttribute(entity, "key") ?? entity.name;
      const value = stringAttribute(entity, "defaultValue");
      return `- \`${key}\`${value === undefined ? "" : ` = \`${value}\``}`;
    })
    .join("\n");
}

function buildCommands(entities: readonly DocumentationEntity[]): string {
  const commands = entities
    .filter(({ kind }) => kind === "build_script")
    .flatMap((entity) => {
      const value = entity.attributes.commands;
      return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [];
    });
  return commands.length === 0
    ? "- No build commands were inferred."
    : [...new Set(commands)]
        .sort()
        .map((command) => `- \`${command}\``)
        .join("\n");
}

function entityFacts(entities: readonly DocumentationEntity[]): string {
  if (entities.length === 0) return "- No facts selected.";
  return entities
    .map(
      (entity) =>
        `- **${entity.kind}** \`${entity.qualifiedName ?? entity.name}\` — confidence ${Math.round((entity.confidence ?? 1) * 100)}%`,
    )
    .join("\n");
}

export interface DeterministicTemplateInput {
  readonly entityKeys?: readonly string[];
  readonly kind: DocumentationKind;
  readonly snapshot: DocumentationFactSnapshot;
}

export interface DeterministicTemplateResult {
  readonly diagram: string;
  readonly facts: string;
  readonly overview: string;
}

export function renderDeterministicTemplate(
  input: DeterministicTemplateInput,
): DeterministicTemplateResult {
  const entities = selectedEntities(input.snapshot, input.entityKeys);
  const counts = new Map<string, number>();
  for (const entity of entities) counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  const countSummary = [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  const overview = `This page is grounded in revision \`${input.snapshot.revisionId}\` and ${entities.length} selected canonical facts${countSummary.length === 0 ? "." : ` (${countSummary}).`}`;
  let facts = entityFacts(entities);
  if (input.kind === "api") facts = endpointFacts(entities);
  if (input.kind === "configuration") facts = configurationFacts(entities);
  if (input.kind === "onboarding") {
    facts = `### Entry points\n\n${endpointFacts(entities)}\n\n### Local commands\n\n${buildCommands(entities)}\n\n### Key entities\n\n${entityFacts(entities)}`;
  }
  const diagram = renderMermaidFlowchart(buildMermaidData(input.snapshot, input.entityKeys));
  return { diagram, facts, overview };
}
