import type {
  GraphNode,
  GraphTraversal,
  TraversalQuery,
  TraversalResult,
} from "@intellirepo/graph";
import type { SemanticSearchResult } from "@intellirepo/embeddings";

import type { EvidencePack, EvidenceReference, QuestionIntent } from "./qa-model.js";

export interface EntityLookup {
  find(
    repositoryId: string,
    searchTerm: string,
    intent: QuestionIntent,
  ): Promise<readonly GraphNode[]>;
}

export interface StructuralEvidenceReader {
  references(
    repositoryId: string,
    entityIds: readonly string[],
  ): Promise<readonly Omit<EvidenceReference, "id">[]>;
}

export interface SemanticSearch {
  search(
    repositoryId: string,
    query: string,
    limit?: number,
  ): Promise<readonly SemanticSearchResult[]>;
}

function traversalPolicy(
  intent: QuestionIntent,
  repositoryId: string,
  revisionId: string,
  keys: readonly string[],
): TraversalQuery {
  const common = {
    maxDepth: 3,
    maxNodes: 80,
    repositoryId,
    revisionId,
    startEntityKeys: keys,
  } as const;
  switch (intent.kind) {
    case "callers":
      return {
        ...common,
        direction: "incoming",
        mode: "neighborhood",
        relationshipKinds: ["CALLS", "IMPORTS", "DEPENDS_ON"],
      };
    case "callees":
      return {
        ...common,
        direction: "outgoing",
        mode: "neighborhood",
        relationshipKinds: ["CALLS", "IMPORTS", "DEPENDS_ON"],
      };
    case "endpoint_flow":
      return {
        ...common,
        direction: "both",
        mode: "endpoint-flow",
        relationshipKinds: ["HANDLES", "CALLS", "USES_MIDDLEWARE", "READS_CONFIG"],
      };
    case "configuration_usage":
      return {
        ...common,
        direction: "incoming",
        mode: "neighborhood",
        relationshipKinds: ["READS_CONFIG"],
      };
    case "test_impact":
      return {
        ...common,
        direction: "incoming",
        mode: "neighborhood",
        relationshipKinds: ["TESTS", "CALLS", "IMPORTS"],
      };
    case "documentation_impact":
      return {
        ...common,
        direction: "incoming",
        mode: "neighborhood",
        relationshipKinds: ["DOCUMENTS"],
      };
    case "module_explanation":
      return {
        ...common,
        direction: "both",
        mode: "neighborhood",
        relationshipKinds: ["CONTAINS", "DECLARES", "DEPENDS_ON", "HANDLES"],
      };
    case "entity_lookup":
      return { ...common, maxDepth: 0, mode: "neighborhood" };
    case "semantic_unknown":
      throw new Error("Semantic-only questions do not create graph traversal queries");
  }
}

function semanticReferences(
  results: readonly SemanticSearchResult[],
): readonly Omit<EvidenceReference, "id">[] {
  return results.map(({ chunk, similarity }) => ({
    confidence: Math.max(0, Math.min(1, similarity)),
    evidence: chunk.content,
    path: String(chunk.metadata.path),
    sourceId: chunk.id,
    sourceKind: "semantic",
    ...(chunk.startLine === undefined ? {} : { startLine: chunk.startLine }),
    ...(chunk.endLine === undefined ? {} : { endLine: chunk.endLine }),
  }));
}

export class EvidencePackBuilder {
  public constructor(
    private readonly traversal: GraphTraversal,
    private readonly lookup: EntityLookup,
    private readonly structuralEvidence: StructuralEvidenceReader,
    private readonly semantic?: SemanticSearch,
  ) {}

  public async build(input: {
    readonly intent: QuestionIntent;
    readonly question: string;
    readonly repositoryId: string;
    readonly revisionId: string;
  }): Promise<{ readonly degradedReasons: readonly string[]; readonly pack: EvidencePack }> {
    const degradedReasons: string[] = [];
    let traversal: TraversalResult | undefined;
    if (input.intent.structural) {
      const roots = await this.lookup.find(
        input.repositoryId,
        input.intent.searchTerm,
        input.intent,
      );
      if (roots.length > 0) {
        traversal = await this.traversal.traverse(
          traversalPolicy(
            input.intent,
            input.repositoryId,
            input.revisionId,
            roots.slice(0, 5).map(({ stableKey }) => stableKey),
          ),
        );
        if (traversal.projection.degradedReason !== undefined)
          degradedReasons.push(traversal.projection.degradedReason);
      } else {
        degradedReasons.push(`No canonical entity matched ${input.intent.searchTerm}`);
      }
    }
    const nodes = traversal?.nodes ?? [];
    const structural = await this.structuralEvidence.references(
      input.repositoryId,
      nodes.map(({ id }) => id),
    );
    let semantic: readonly SemanticSearchResult[] = [];
    if (this.semantic === undefined) {
      degradedReasons.push("Semantic projection is unavailable");
    } else {
      try {
        semantic = await this.semantic.search(input.repositoryId, input.question, 6);
      } catch (error) {
        degradedReasons.push(
          `Semantic retrieval failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const references = [...structural, ...semanticReferences(semantic)].map((reference, index) => ({
      ...reference,
      id: `E${String(index + 1)}`,
    }));
    return {
      degradedReasons,
      pack: {
        ...(traversal === undefined
          ? {}
          : { adapter: traversal.adapter, projection: traversal.projection }),
        edges: traversal?.edges ?? [],
        intent: input.intent,
        nodes,
        references,
        truncated: traversal?.truncated ?? false,
      },
    };
  }
}
