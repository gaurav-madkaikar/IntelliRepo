import type {
  DocumentationClaim,
  DocumentationEntity,
  DocumentationFactSnapshot,
  DocumentationGap,
  DocumentationGapKind,
} from "../documentation-model.js";
import { stableHash } from "../markdown/markdown-parser.js";

function stringAttribute(entity: DocumentationEntity, name: string): string | undefined {
  const value = entity.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLocaleLowerCase();
}

function gap(
  entity: DocumentationEntity,
  kind: DocumentationGapKind,
  message: string,
  suggestedPath: string,
): DocumentationGap {
  return {
    entityKey: entity.stableKey,
    id: `doc-gap:${stableHash(entity.stableKey, kind)}`,
    kind,
    message,
    severity: "informational",
    suggestedPath,
  };
}

function entityDocumented(
  entity: DocumentationEntity,
  claims: readonly DocumentationClaim[],
): boolean {
  return claims.some(
    (claim) =>
      claim.kind === "entity" &&
      (claim.payload.name === entity.name || claim.payload.name === entity.qualifiedName),
  );
}

export function detectDocumentationGaps(
  snapshot: DocumentationFactSnapshot,
  claims: readonly DocumentationClaim[],
  changedEntityKeys: readonly string[] = [],
): readonly DocumentationGap[] {
  const gaps: DocumentationGap[] = [];
  for (const entity of snapshot.entities) {
    if (entity.kind === "endpoint") {
      const method = stringAttribute(entity, "httpMethod")?.toUpperCase();
      const path = stringAttribute(entity, "normalizedPath");
      const documented = claims.some(
        (claim) =>
          claim.kind === "endpoint" &&
          claim.payload.method === method &&
          claim.payload.path === path,
      );
      if (!documented && method !== undefined && path !== undefined) {
        gaps.push(
          gap(
            entity,
            "endpoint",
            `${method} ${path} has no matching endpoint claim`,
            `docs/intellirepo/api/${slug(`${method}-${path}`)}.md`,
          ),
        );
      }
    }
    if (entity.kind === "module" && !entityDocumented(entity, claims)) {
      gaps.push(
        gap(
          entity,
          "module",
          `${entity.name} has no matching module documentation claim`,
          `docs/intellirepo/modules/${slug(entity.name)}.md`,
        ),
      );
    }
    if (entity.kind === "configuration_key") {
      const key = stringAttribute(entity, "key") ?? entity.name;
      const documented = claims.some(
        (claim) => claim.kind === "configuration" && claim.payload.key === key,
      );
      if (!documented) {
        gaps.push(
          gap(
            entity,
            "configuration",
            `${key} has no matching configuration claim`,
            "docs/intellirepo/configuration.md",
          ),
        );
      }
    }
  }

  const existing = new Set(gaps.map(({ entityKey }) => entityKey));
  for (const entityKey of [...new Set(changedEntityKeys)].sort()) {
    const entity = snapshot.entities.find(({ stableKey }) => stableKey === entityKey);
    if (entity === undefined || existing.has(entityKey) || entityDocumented(entity, claims))
      continue;
    gaps.push(
      gap(
        entity,
        "changed_component",
        `Changed ${entity.kind} ${entity.name} has no matching documentation claim`,
        "docs/intellirepo/changes/",
      ),
    );
  }
  return gaps.sort((left, right) => left.id.localeCompare(right.id));
}
