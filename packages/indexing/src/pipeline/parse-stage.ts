import { createHash } from "node:crypto";

import { ArtifactCatalog, stageFactSet, type CatalogDatabase } from "@intellirepo/catalog";
import type { ScanDiagnostic } from "@intellirepo/contracts";
import {
  createDefaultAdapterRegistry,
  ExtractionPipeline,
  IncrementalExtractionCoordinator,
  type SourceArtifactInput,
} from "@intellirepo/parsing";
import type { LoadedRepositoryArtifact } from "@intellirepo/repository";
import type { Kysely } from "kysely";

import type { ScanExecutionContext } from "../executor/scan-context.js";
import {
  ScanStageExecutionError,
  type ScanStageHandler,
  type ScanStageResult,
} from "../executor/scan-stage.js";
import { RepositorySnapshotProvider } from "./repository-snapshot-provider.js";

function stagingRunId(revisionId: string, artifactId: string): string {
  const digest = createHash("sha256")
    .update(`${revisionId}\u001f${artifactId}`)
    .digest("hex")
    .slice(0, 24);
  return `facts-${digest}`;
}

function parsingArtifact(artifact: LoadedRepositoryArtifact): SourceArtifactInput | undefined {
  if (artifact.decision.artifactKind === "documentation") return undefined;
  return {
    artifactKind: artifact.decision.artifactKind,
    content: artifact.content,
    ...(artifact.decision.language === undefined ? {} : { language: artifact.decision.language }),
    path: artifact.path,
  };
}

function scanDiagnostic(
  diagnostic: Awaited<
    ReturnType<IncrementalExtractionCoordinator["extract"]>
  >["extraction"]["diagnostics"][number],
): ScanDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    path: diagnostic.artifactPath,
    severity: diagnostic.severity === "information" ? "info" : diagnostic.severity,
    stage: "PARSING",
  };
}

export class ParseRepositoryStage implements ScanStageHandler {
  public readonly stage = "PARSING" as const;
  private readonly artifacts: ArtifactCatalog;
  private readonly extraction: IncrementalExtractionCoordinator;

  public constructor(
    private readonly database: Kysely<CatalogDatabase>,
    private readonly snapshots: RepositorySnapshotProvider,
  ) {
    this.artifacts = new ArtifactCatalog(database);
    this.extraction = new IncrementalExtractionCoordinator(
      new ExtractionPipeline(createDefaultAdapterRegistry()),
    );
  }

  public async run(context: ScanExecutionContext): Promise<ScanStageResult> {
    try {
      const snapshot = await this.snapshots.load(context);
      const sourceArtifacts = snapshot.artifacts.flatMap((artifact) => {
        const input = parsingArtifact(artifact);
        return input === undefined ? [] : [input];
      });
      const result = await this.extraction.extract({
        artifacts: sourceArtifacts,
        changeSet: snapshot.changeSet,
        revisionId: context.scan.revisionId,
      });
      const extractionByPath = new Map(
        result.extraction.artifacts.map((artifact) => [artifact.artifactPath, artifact]),
      );
      const changedPaths = new Set(
        snapshot.changeSet.changes.flatMap((change) =>
          "current" in change ? [change.current.path] : [],
        ),
      );
      const changedArtifacts = snapshot.artifacts.filter(({ path }) => changedPaths.has(path));
      let stagedFacts = 0;
      let extractedEntities = 0;
      let extractedRelationships = 0;

      for (const artifact of changedArtifacts) {
        const catalogArtifact = await this.artifacts.upsert({
          artifactKind: artifact.decision.artifactKind,
          contentHash: artifact.contentHash,
          ...(artifact.decision.language === undefined
            ? {}
            : { language: artifact.decision.language }),
          path: artifact.path,
          repositoryId: context.scan.repositoryId,
          sizeBytes: artifact.sizeBytes,
        });
        const extracted = extractionByPath.get(artifact.path);
        const id = stagingRunId(context.scan.revisionId, catalogArtifact.id);
        const existing = await this.database
          .selectFrom("fact_staging_runs")
          .select("id")
          .where("id", "=", id)
          .executeTakeFirst();
        if (existing === undefined) {
          await stageFactSet(this.database, {
            artifactId: catalogArtifact.id,
            entities: extracted?.entities ?? [],
            id,
            relationships: extracted?.relationships ?? [],
            repositoryId: context.scan.repositoryId,
            revisionId: context.scan.revisionId,
          });
        }
        stagedFacts += 1;
        extractedEntities += extracted?.entities.length ?? 0;
        extractedRelationships += extracted?.relationships.length ?? 0;
      }

      return {
        counts: {
          extractedEntities,
          extractedRelationships,
          parsedArtifacts: result.extraction.artifacts.length,
          stagedArtifacts: stagedFacts,
        },
        diagnostics: result.extraction.diagnostics.map(scanDiagnostic),
      };
    } catch (error) {
      throw new ScanStageExecutionError(
        error instanceof Error ? error.message : "Repository parsing failed",
        true,
        { cause: error },
      );
    }
  }
}
