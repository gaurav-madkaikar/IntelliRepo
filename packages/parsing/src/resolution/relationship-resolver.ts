import type { EntityFact } from "@intellirepo/domain";

import type { ArtifactExtractionResult } from "../interfaces/extraction.js";
import { resolveCrossLanguageReferences } from "../pipeline/cross-language-resolver.js";

export interface ResolveAffectedRelationshipsInput {
  /** Freshly parsed results. Only these artifacts are returned and should be staged. */
  readonly changedArtifacts: readonly ArtifactExtractionResult[];
  /** Canonical entities from unchanged artifacts; these are lookup context, never re-staged. */
  readonly unchangedEntities: readonly EntityFact[];
  readonly repositoryId: string;
  readonly revisionId: string;
}

/**
 * Re-resolves changed artifacts against the current canonical symbol set without parsing or
 * rewriting unchanged files. This is the incremental relationship boundary used by workers.
 */
export function resolveAffectedRelationships(
  input: ResolveAffectedRelationshipsInput,
): readonly ArtifactExtractionResult[] {
  return resolveCrossLanguageReferences(
    input.changedArtifacts,
    input.repositoryId,
    input.revisionId,
    input.unchangedEntities,
  );
}
