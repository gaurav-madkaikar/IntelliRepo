import type {
  DocumentationClaim,
  DocumentationEntity,
  DocumentationFinding,
  DocumentationFactSnapshot,
} from "../documentation-model.js";
import { stableHash } from "../markdown/markdown-parser.js";

function stringAttribute(entity: DocumentationEntity, name: string): string | undefined {
  const value = entity.attributes[name];
  return typeof value === "string" ? value : undefined;
}

function finding(
  claim: DocumentationClaim,
  input: Omit<DocumentationFinding, "claimId" | "id" | "pageId">,
): DocumentationFinding {
  return {
    ...input,
    claimId: claim.id,
    id: `doc-finding:${stableHash(claim.id, input.kind)}`,
    pageId: claim.pageId,
  };
}

function normalizedCommand(command: string): string {
  return command.replace(/\s+/gu, " ").trim();
}

function endpointFindings(
  claim: DocumentationClaim,
  endpoints: readonly DocumentationEntity[],
): readonly DocumentationFinding[] {
  const method = String(claim.payload.method).toUpperCase();
  const path = String(claim.payload.path);
  const exact = endpoints.find(
    (entity) =>
      stringAttribute(entity, "httpMethod")?.toUpperCase() === method &&
      stringAttribute(entity, "normalizedPath") === path,
  );
  if (exact !== undefined) return [];
  const candidates = endpoints
    .filter((entity) => stringAttribute(entity, "httpMethod")?.toUpperCase() === method)
    .map((entity) => stringAttribute(entity, "normalizedPath"))
    .filter((value): value is string => value !== undefined)
    .sort();
  return [
    finding(claim, {
      evidence: { candidates, documentedMethod: method, documentedPath: path },
      kind: "stale_endpoint",
      message: `${method} ${path} is not declared by the indexed repository`,
      severity: "high",
      status: "confirmed",
      ...(candidates.length === 1 ? { suggestedText: `${method} ${candidates[0] as string}` } : {}),
    }),
  ];
}

function entityFindings(
  claim: DocumentationClaim,
  entities: readonly DocumentationEntity[],
): readonly DocumentationFinding[] {
  const documentedName = String(claim.payload.name);
  const exact = entities.some(
    (entity) =>
      entity.name === documentedName ||
      entity.qualifiedName === documentedName ||
      entity.qualifiedName?.endsWith(`.${documentedName}`) === true,
  );
  if (exact) return [];
  const review = claim.confidence < 0.8;
  const critical = /auth|security|token|permission/iu.test(documentedName);
  return [
    finding(claim, {
      evidence: { documentedName, extractionConfidence: claim.confidence },
      kind: review ? "ambiguous_claim" : "removed_entity",
      message: review
        ? `${documentedName} may be a code entity, but the prose is ambiguous`
        : `${documentedName} is mentioned but is absent from current canonical facts`,
      severity: review ? "informational" : critical ? "high" : "low",
      status: review ? "review" : "confirmed",
    }),
  ];
}

function configurationFindings(
  claim: DocumentationClaim,
  configuration: readonly DocumentationEntity[],
): readonly DocumentationFinding[] {
  const key = String(claim.payload.key);
  const documentedValue = String(claim.payload.value);
  const current = configuration.find(
    (entity) => stringAttribute(entity, "key") === key || entity.name === key,
  );
  if (current === undefined) {
    return [
      finding(claim, {
        evidence: { documentedKey: key, documentedValue },
        kind: "stale_configuration",
        message: `${key} is documented but is absent from current configuration facts`,
        severity: "high",
        status: "confirmed",
      }),
    ];
  }
  const currentValue = stringAttribute(current, "defaultValue");
  if (currentValue === undefined || currentValue === documentedValue) return [];
  return [
    finding(claim, {
      evidence: {
        currentValue,
        documentedValue,
        source: current.source,
      },
      kind: "stale_configuration",
      message: `${key} is documented as ${documentedValue}, but canonical facts declare ${currentValue}`,
      severity: "high",
      status: "confirmed",
      suggestedText: `${key} = ${currentValue}`,
    }),
  ];
}

function commandFindings(
  claim: DocumentationClaim,
  buildScripts: readonly DocumentationEntity[],
): readonly DocumentationFinding[] {
  const command = normalizedCommand(String(claim.payload.command));
  const commands = buildScripts.flatMap((entity) => {
    const value = entity.attributes.commands;
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string").map(normalizedCommand)
      : [];
  });
  if (commands.includes(command)) return [];
  return [
    finding(claim, {
      evidence: { availableCommands: [...new Set(commands)].sort(), documentedCommand: command },
      kind: "stale_command",
      message: `${command} is not exposed by the indexed build metadata`,
      severity: "medium",
      status: "confirmed",
    }),
  ];
}

function sourceLinkFindings(
  claim: DocumentationClaim,
  filePaths: ReadonlySet<string>,
): readonly DocumentationFinding[] {
  const artifactPath = String(claim.payload.path).replace(/^\.\//u, "");
  if (filePaths.has(artifactPath)) return [];
  return [
    finding(claim, {
      evidence: { documentedPath: artifactPath },
      kind: "stale_source_link",
      message: `${artifactPath} is linked but is absent from indexed files`,
      severity: "low",
      status: "confirmed",
    }),
  ];
}

export function compareClaims(
  claims: readonly DocumentationClaim[],
  snapshot: DocumentationFactSnapshot,
  additionalValidPaths: readonly string[] = [],
): readonly DocumentationFinding[] {
  const endpoints = snapshot.entities.filter(({ kind }) => kind === "endpoint");
  const configuration = snapshot.entities.filter(({ kind }) => kind === "configuration_key");
  const buildScripts = snapshot.entities.filter(({ kind }) => kind === "build_script");
  const filePaths = new Set(
    snapshot.entities
      .filter(({ kind }) => kind === "file")
      .flatMap((entity) => {
        const path = stringAttribute(entity, "path") ?? entity.source?.artifactPath;
        return path === undefined ? [] : [path.replace(/^\.\//u, "")];
      }),
  );
  for (const path of additionalValidPaths) filePaths.add(path.replace(/^\.\//u, ""));

  return claims
    .flatMap((claim) => {
      switch (claim.kind) {
        case "endpoint":
          return endpointFindings(claim, endpoints);
        case "entity":
          return entityFindings(claim, snapshot.entities);
        case "configuration":
          return configurationFindings(claim, configuration);
        case "command":
          return commandFindings(claim, buildScripts);
        case "source_link":
          return sourceLinkFindings(claim, filePaths);
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
