import type { CatalogDatabase } from "@intellirepo/catalog";
import type { SemanticSource } from "@intellirepo/embeddings";
import type { LoadedRepositoryArtifact } from "@intellirepo/repository";
import type { Kysely } from "kysely";

import type { ScanExecutionContext } from "../executor/scan-context.js";
import { RepositorySnapshotProvider } from "../pipeline/repository-snapshot-provider.js";

const USEFUL_ENTITY_KINDS = new Set([
  "class",
  "configuration",
  "configuration_key",
  "controller",
  "endpoint",
  "function",
  "interface",
  "method",
  "module",
  "route",
  "service",
]);
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u;

interface EntityCandidate {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly artifactPath: string;
  readonly kind: string;
  readonly stableKey: string;
}

export interface SemanticSourceBuildInput {
  readonly artifacts: readonly LoadedRepositoryArtifact[];
  readonly entities: readonly EntityCandidate[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly sourceArtifactIds: ReadonlyMap<string, string>;
}

export interface SemanticSourceBuildResult {
  readonly removedSourceIds: readonly string[];
  readonly sources: readonly SemanticSource[];
}

function isPublicUsefulEntity(entity: EntityCandidate): boolean {
  const visibility = entity.attributes.visibility;
  return visibility !== "private" && USEFUL_ENTITY_KINDS.has(entity.kind);
}

function documentationSections(content: string): readonly {
  readonly content: string;
  readonly endLine: number;
  readonly index: number;
  readonly startLine: number;
}[] {
  const lines = content.split("\n");
  const starts = lines.flatMap((line, index) => (/^#{1,6}\s+\S/u.test(line) ? [index] : []));
  if (starts.length === 0) {
    return content.trim().length === 0
      ? []
      : [{ content, endLine: lines.length, index: 1, startLine: 1 }];
  }
  return starts.map((start, index) => {
    const end = (starts[index + 1] ?? lines.length) - 1;
    return {
      content: lines.slice(start, end + 1).join("\n"),
      endLine: end + 1,
      index: index + 1,
      startLine: start + 1,
    };
  });
}

export function selectSemanticSources(input: SemanticSourceBuildInput): readonly SemanticSource[] {
  const entitiesByPath = new Map<string, EntityCandidate[]>();
  for (const entity of input.entities.filter(isPublicUsefulEntity)) {
    entitiesByPath.set(entity.artifactPath, [
      ...(entitiesByPath.get(entity.artifactPath) ?? []),
      entity,
    ]);
  }
  const sources: SemanticSource[] = [];
  for (const artifact of input.artifacts) {
    const artifactId = input.sourceArtifactIds.get(artifact.path);
    if (artifactId === undefined || LOCKFILE.test(artifact.path)) continue;
    const common = {
      artifactId,
      artifactKind: artifact.decision.artifactKind,
      contentHash: artifact.contentHash,
      path: artifact.path,
      repositoryId: input.repositoryId,
      revisionId: input.revisionId,
    } as const;
    if (artifact.decision.artifactKind === "documentation") {
      for (const section of documentationSections(artifact.content)) {
        sources.push({
          ...common,
          chunkKind: "documentation-section",
          content: section.content,
          endLine: section.endLine,
          sourceId: `${artifactId}#section-${String(section.index)}`,
          sourceKind: "documentation",
          startLine: section.startLine,
        });
      }
      continue;
    }
    if (artifact.decision.artifactKind !== "code") continue;
    const useful = entitiesByPath.get(artifact.path) ?? [];
    if (useful.length === 0) continue;
    sources.push({
      ...common,
      chunkKind: "source-region",
      content: artifact.content,
      endLine: artifact.content.split("\n").length,
      ...(artifact.decision.language === undefined ? {} : { language: artifact.decision.language }),
      metadata: { selectedEntityKeys: useful.map(({ stableKey }) => stableKey).sort() },
      sourceId: artifactId,
      sourceKind: "source",
      startLine: 1,
    });
  }
  return sources;
}

export class SemanticSourceBuilder {
  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    private readonly snapshots: RepositorySnapshotProvider,
  ) {}

  public async build(context: ScanExecutionContext): Promise<SemanticSourceBuildResult> {
    const snapshot = await this.snapshots.load(context);
    const fullSnapshot = await this.snapshots.loadFull(context);
    const paths = fullSnapshot.artifacts.map(({ path }) => path);
    const sourceArtifacts =
      paths.length === 0
        ? []
        : await this.database
            .selectFrom("source_artifacts")
            .select(["id", "path"])
            .where("repository_id", "=", context.scan.repositoryId)
            .where("path", "in", paths)
            .execute();
    const entities =
      paths.length === 0
        ? []
        : await this.database
            .selectFrom("entities as entity")
            .innerJoin("source_artifacts as artifact", "artifact.id", "entity.owner_artifact_id")
            .select([
              "artifact.path as artifactPath",
              "entity.attributes",
              "entity.kind",
              "entity.stable_key as stableKey",
            ])
            .where("entity.repository_id", "=", context.scan.repositoryId)
            .where("artifact.path", "in", paths)
            .execute();
    const removedPaths = new Set(
      snapshot.changeSet.changes.flatMap((change) =>
        change.kind === "deleted" || change.kind === "renamed" ? [change.previous.path] : [],
      ),
    );
    const semanticRows =
      removedPaths.size === 0
        ? []
        : await this.database
            .selectFrom("semantic_chunks")
            .select("metadata")
            .where("repository_id", "=", context.scan.repositoryId)
            .execute();
    const removedSourceIds = [
      ...new Set(
        semanticRows.flatMap(({ metadata }) =>
          removedPaths.has(String(metadata.path)) && typeof metadata.parentSourceId === "string"
            ? [metadata.parentSourceId]
            : [],
        ),
      ),
    ];
    return {
      removedSourceIds,
      sources: selectSemanticSources({
        artifacts: fullSnapshot.artifacts,
        entities,
        repositoryId: context.scan.repositoryId,
        revisionId: context.scan.revisionId,
        sourceArtifactIds: new Map(sourceArtifacts.map(({ id, path }) => [path, id])),
      }),
    };
  }
}
