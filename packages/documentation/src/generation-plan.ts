import type {
  DocumentationEntity,
  DocumentationFactSnapshot,
  DocumentationSourceReference,
} from "./documentation-model.js";
import { stableHash } from "./markdown/markdown-parser.js";
import { contentChecksum, createReviewDiff } from "./review-diff.js";
import {
  renderDeterministicTemplate,
  type DocumentationKind,
} from "./templates/document-templates.js";

export interface DocumentationEnhancer {
  enhance(input: {
    readonly facts: readonly {
      readonly kind: string;
      readonly name: string;
      readonly source?: DocumentationSourceReference;
    }[];
    readonly kind: DocumentationKind;
    readonly revisionId: string;
    readonly section: "overview";
  }): Promise<string>;
}

export interface DocumentationGenerationRequest {
  readonly enhancer?: DocumentationEnhancer;
  readonly entityKeys?: readonly string[];
  readonly kind: DocumentationKind;
  readonly originalMarkdown?: string;
  readonly snapshot: DocumentationFactSnapshot;
  readonly targetPath?: string;
  readonly title: string;
}

export interface DocumentationManifest {
  readonly entityKeys: readonly string[];
  readonly generatedBy: "IntelliRepo";
  readonly kind: DocumentationKind;
  readonly relationshipIds: readonly string[];
  readonly repositoryId: string;
  readonly revisionId: string;
  readonly sourceReferences: readonly string[];
}

export interface DocumentationReviewPreview {
  readonly diff: string;
  readonly enhancement: {
    readonly reason?: string;
    readonly state: "applied" | "degraded" | "disabled";
  };
  readonly id: string;
  readonly manifest: DocumentationManifest;
  readonly originalChecksum: string;
  readonly path: string;
  readonly proposedMarkdown: string;
  readonly repositoryId: string;
  readonly revisionId: string;
}

function slug(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")
    .toLocaleLowerCase();
}

export function defaultDocumentationPath(kind: DocumentationKind, title: string): string {
  switch (kind) {
    case "onboarding":
      return "docs/intellirepo/onboarding.md";
    case "architecture":
      return "docs/intellirepo/architecture/overview.md";
    case "configuration":
      return "docs/intellirepo/configuration.md";
    case "api":
      return `docs/intellirepo/api/${slug(title)}.md`;
    case "module":
      return `docs/intellirepo/modules/${slug(title)}.md`;
    case "change":
      return `docs/intellirepo/changes/${slug(title)}.md`;
  }
}

function selectedEntities(
  snapshot: DocumentationFactSnapshot,
  keys?: readonly string[],
): readonly DocumentationEntity[] {
  const selected = keys === undefined ? undefined : new Set(keys);
  return snapshot.entities
    .filter((entity) => selected === undefined || selected.has(entity.stableKey))
    .sort((left, right) => left.stableKey.localeCompare(right.stableKey));
}

function sourceReferences(entities: readonly DocumentationEntity[]): readonly string[] {
  return [
    ...new Set(
      entities.flatMap((entity) => {
        const source = entity.source;
        if (source === undefined) return [];
        const range =
          source.startLine === undefined
            ? ""
            : `:${source.startLine}${source.endLine === undefined || source.endLine === source.startLine ? "" : `-${source.endLine}`}`;
        return [`${source.artifactPath}${range}`];
      }),
    ),
  ].sort();
}

function renderSources(references: readonly string[]): string {
  return references.length === 0
    ? "- No source locations were available for the selected facts."
    : references.map((reference) => `- \`${reference}\``).join("\n");
}

export class DocumentationGenerator {
  public async prepare(
    request: DocumentationGenerationRequest,
  ): Promise<DocumentationReviewPreview> {
    const original = request.originalMarkdown ?? "";
    const path = request.targetPath ?? defaultDocumentationPath(request.kind, request.title);
    const entities = selectedEntities(request.snapshot, request.entityKeys);
    const entityKeys = entities.map(({ stableKey }) => stableKey);
    const entityKeySet = new Set(entityKeys);
    const relationships = request.snapshot.relationships
      .filter(
        ({ sourceEntityKey, targetEntityKey }) =>
          entityKeySet.has(sourceEntityKey) || entityKeySet.has(targetEntityKey),
      )
      .sort((left, right) => left.id.localeCompare(right.id));
    const references = sourceReferences(entities);
    const manifest: DocumentationManifest = {
      entityKeys,
      generatedBy: "IntelliRepo",
      kind: request.kind,
      relationshipIds: relationships.map(({ id }) => id),
      repositoryId: request.snapshot.repositoryId,
      revisionId: request.snapshot.revisionId,
      sourceReferences: references,
    };
    const template = renderDeterministicTemplate({
      ...(request.entityKeys === undefined ? {} : { entityKeys: request.entityKeys }),
      kind: request.kind,
      snapshot: request.snapshot,
    });
    let enhancedOverview: string | undefined;
    let enhancement: DocumentationReviewPreview["enhancement"] = {
      reason: "Ollama enhancer unavailable; generated deterministic fact-only Markdown",
      state: "disabled",
    };
    if (request.enhancer !== undefined) {
      try {
        const candidate = await request.enhancer.enhance({
          facts: entities.slice(0, 20).map((entity) => ({
            kind: entity.kind,
            name: entity.name,
            ...(entity.source === undefined ? {} : { source: entity.source }),
          })),
          kind: request.kind,
          revisionId: request.snapshot.revisionId,
          section: "overview",
        });
        if (candidate.trim().length > 0 && candidate.length <= 4_000) {
          enhancedOverview = candidate.trim();
          enhancement = { state: "applied" };
        } else {
          enhancement = {
            reason: "Enhancer returned empty or oversized content; deterministic overview retained",
            state: "degraded",
          };
        }
      } catch (error) {
        enhancement = {
          reason: `Enhancer failed; deterministic overview retained: ${error instanceof Error ? error.message : String(error)}`,
          state: "degraded",
        };
      }
    }
    const generatedNotice = [
      "> [!NOTE]",
      "> Generated by IntelliRepo. Confirmed facts and references are deterministic; AI-enhanced prose is explicitly labeled.",
      `> Indexed revision: \`${request.snapshot.revisionId}\`. AI enhancement: **${enhancement.state}**${enhancement.reason === undefined ? "." : ` — ${enhancement.reason}.`}`,
    ].join("\n");
    const machineManifest = `<!-- intellirepo-manifest ${JSON.stringify(manifest)} -->`;
    const overview =
      enhancedOverview === undefined
        ? template.overview
        : `**AI-assisted explanation:** ${enhancedOverview}`;
    const proposedMarkdown = [
      `# ${request.title}`,
      "",
      generatedNotice,
      "",
      machineManifest,
      "",
      "## Overview",
      "",
      overview,
      "",
      "## Confirmed facts",
      "",
      template.facts,
      "",
      "## Canonical relationship diagram",
      "",
      template.diagram,
      "",
      "## Source references",
      "",
      renderSources(references),
      "",
    ].join("\n");
    return {
      diff: createReviewDiff(path, original, proposedMarkdown),
      enhancement,
      id: `doc-review:${stableHash(request.snapshot.repositoryId, request.snapshot.revisionId, path, contentChecksum(proposedMarkdown))}`,
      manifest,
      originalChecksum: contentChecksum(original),
      path,
      proposedMarkdown,
      repositoryId: request.snapshot.repositoryId,
      revisionId: request.snapshot.revisionId,
    };
  }
}
