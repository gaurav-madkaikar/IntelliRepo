import { createHash } from "node:crypto";

import type { SemanticChunk, SemanticSource } from "./embedding-model.js";
import { redactSecrets } from "./redactor.js";

const EXCLUDED_PATH = /(^|\/)(\.git|\.next|build|coverage|dist|node_modules|target)(\/|$)/u;
const SECRET_FILE = /(^|\/)(\.env|id_rsa|id_ed25519)(\.|$)/u;

function hash(...values: readonly string[]): string {
  return createHash("sha256").update(values.join("\0")).digest("hex");
}

function eligibility(source: SemanticSource): string | undefined {
  if (
    source.generated === true ||
    EXCLUDED_PATH.test(source.path) ||
    SECRET_FILE.test(source.path)
  ) {
    return undefined;
  }
  if (source.sourceKind === "documentation") {
    return source.content.trim().length >= 40 ? "explanatory Markdown section" : undefined;
  }
  if (source.artifactKind !== "code" || source.content.trim().length < 80) return undefined;
  const explanatory =
    /(^|\n)\s*(\/\/|\/\*|\*|#)|\b(class|interface|function|fun|public|private|protected|export|async)\b/u;
  return explanatory.test(source.content) ? "explanatory source span" : undefined;
}

function windows(content: string, maximumCharacters: number): readonly string[] {
  const lines = content.split("\n");
  const chunks: string[] = [];
  let current: string[] = [];
  let length = 0;
  for (const line of lines) {
    if (current.length > 0 && length + line.length + 1 > maximumCharacters) {
      chunks.push(current.join("\n").trim());
      current = current.slice(-3);
      length = current.join("\n").length;
    }
    current.push(line);
    length += line.length + 1;
  }
  const final = current.join("\n").trim();
  if (final.length > 0) chunks.push(final);
  return chunks;
}

export function createSemanticChunks(
  source: SemanticSource,
  maximumCharacters = 1_800,
): readonly SemanticChunk[] {
  const eligibilityReason = eligibility(source);
  if (eligibilityReason === undefined) return [];
  const redacted = redactSecrets(source.content);
  return windows(redacted.content, maximumCharacters).map((content, index) => {
    const sourceId = `${source.sourceId}#chunk-${String(index + 1)}`;
    return {
      checksum: hash(content),
      content,
      ...(source.endLine === undefined ? {} : { endLine: source.endLine }),
      id: `semantic:${hash(source.sourceKind, sourceId).slice(0, 24)}`,
      metadata: {
        ...(source.metadata ?? {}),
        artifactId: source.artifactId ?? "unknown",
        chunkKind:
          source.chunkKind ??
          (source.sourceKind === "documentation" ? "documentation-section" : "source-region"),
        contentHash: source.contentHash ?? hash(source.content),
        eligibilityReason,
        language: source.language ?? "unknown",
        parentSourceId: source.sourceId,
        path: source.path,
        redactionCount: redacted.redactionCount,
        repositoryId: source.repositoryId ?? "unknown",
        revisionId: source.revisionId ?? "unknown",
      },
      sourceId,
      sourceKind: source.sourceKind,
      ...(source.startLine === undefined ? {} : { startLine: source.startLine }),
    };
  });
}
