import { compareClaims } from "./claims/claim-comparator.js";
import { extractClaims } from "./claims/claim-extractor.js";
import type {
  DocumentationAnalysis,
  DocumentationAnalysisInput,
  DocumentationClaim,
  MarkdownPage,
} from "./documentation-model.js";
import { detectDocumentationGaps } from "./gaps/gap-detector.js";
import { calculateDocumentationHealth } from "./health-score.js";
import { markdownContentHash, parseMarkdown } from "./markdown/markdown-parser.js";

export class DocumentationAnalyzer {
  public analyze(input: DocumentationAnalysisInput): DocumentationAnalysis {
    const { repositoryId, revisionId } = input.snapshot;
    if (input.previous !== undefined && input.previous.repositoryId !== repositoryId) {
      throw new Error("Previous documentation analysis belongs to another repository");
    }
    const affectedPaths = new Set(input.affectedPaths ?? []);
    const previousPages = new Map(input.previous?.pages.map((page) => [page.path, page]));
    const previousClaims = new Map<string, readonly DocumentationClaim[]>();
    for (const page of input.previous?.pages ?? []) {
      previousClaims.set(
        page.id,
        input.previous?.claims.filter(({ pageId }) => pageId === page.id) ?? [],
      );
    }

    const pages: MarkdownPage[] = [];
    const claims: DocumentationClaim[] = [];
    const reusedPaths: string[] = [];
    for (const document of [...input.documents].sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const previous = previousPages.get(document.path);
      const canReuse =
        previous !== undefined &&
        previous.contentHash === markdownContentHash(document.content) &&
        !affectedPaths.has(document.path);
      if (canReuse) {
        pages.push(previous);
        claims.push(...(previousClaims.get(previous.id) ?? []));
        reusedPaths.push(document.path);
        continue;
      }
      const page = parseMarkdown(repositoryId, revisionId, document);
      pages.push(page);
      claims.push(...extractClaims(page));
    }
    const findings = compareClaims(
      claims,
      input.snapshot,
      pages.map(({ path }) => path),
    );
    const gaps = detectDocumentationGaps(input.snapshot, claims, input.changedEntityKeys);
    return {
      claims,
      findings,
      gaps,
      health: calculateDocumentationHealth(findings, gaps, input.indexingCompleteness),
      pages,
      repositoryId,
      reusedPaths,
      revisionId,
    };
  }
}
