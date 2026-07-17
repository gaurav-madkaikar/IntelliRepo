import type {
  DocumentationClaim,
  DocumentationClaimKind,
  MarkdownPage,
} from "../documentation-model.js";
import { stableHash } from "../markdown/markdown-parser.js";

const HTTP_METHODS = "GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS";
const ENDPOINT_PATTERN = new RegExp(`\\b(${HTTP_METHODS})\\s+[\\x60]?(/[^\\s\\x60),;]+)`, "giu");
const CONFIG_PATTERN =
  /(?:`)?([A-Za-z][\w-]*(?:\.[\w-]+)+|[A-Z][A-Z0-9_]{2,})(?:`)?\s*(?:=|:|is)\s*(?:`|"|')?([^\s`"',;.]+)/giu;
const SOURCE_LINK_PATTERN =
  /\[[^\]]*\]\(([^)\s]+\.(?:java|kt|kts|js|jsx|ts|tsx|json|ya?ml|properties|xml|md)(?:#[^)]*)?)\)/giu;
const INLINE_ENTITY_PATTERN = /`([A-Z][A-Za-z0-9_$]*(?:\.[A-Za-z_$][\w$]*(?:\(\))?)?)`/gu;
const AMBIGUOUS_ENTITY_PATTERN = /\b(?:class|function|module|service)\s+([A-Z][A-Za-z0-9_$]+)/giu;
const COMMAND_PATTERN =
  /^\s*(\.\/)?(?:gradlew|mvnw)\b.*$|^\s*(?:gradle|mvn|npm|pnpm|yarn)\b.*$/gimu;

function normalizedPath(value: string): string {
  return value.split("?")[0]?.replace(/:([A-Za-z_$][\w$]*)/gu, "{$1}") ?? value;
}

function makeClaim(
  page: MarkdownPage,
  sectionId: string,
  kind: DocumentationClaimKind,
  line: number,
  sourceText: string,
  payload: Readonly<Record<string, string | number>>,
  confidence: number,
): DocumentationClaim {
  return {
    confidence,
    id: `doc-claim:${stableHash(sectionId, kind, String(line), JSON.stringify(payload))}`,
    kind,
    line,
    pageId: page.id,
    payload,
    sectionId,
    sourceText: sourceText.trim(),
  };
}

function lineAt(body: string, startLine: number, offset: number): number {
  return startLine + body.slice(0, offset).split("\n").length - 1;
}

function matches(pattern: RegExp, value: string): readonly RegExpExecArray[] {
  pattern.lastIndex = 0;
  return [...value.matchAll(pattern)];
}

export function extractClaims(page: MarkdownPage): readonly DocumentationClaim[] {
  const claims: DocumentationClaim[] = [];
  for (const section of page.sections) {
    const bodyStart = section.level === 0 ? section.lineStart : section.lineStart + 1;
    for (const match of matches(ENDPOINT_PATTERN, section.body)) {
      const method = match[1]?.toUpperCase();
      const route = match[2];
      if (method === undefined || route === undefined) continue;
      claims.push(
        makeClaim(
          page,
          section.id,
          "endpoint",
          lineAt(section.body, bodyStart, match.index ?? 0),
          match[0],
          { method, path: normalizedPath(route) },
          1,
        ),
      );
    }
    for (const match of matches(CONFIG_PATTERN, section.body)) {
      const key = match[1];
      const value = match[2];
      if (key === undefined || value === undefined || key.startsWith("http")) continue;
      claims.push(
        makeClaim(
          page,
          section.id,
          "configuration",
          lineAt(section.body, bodyStart, match.index ?? 0),
          match[0],
          { key, value },
          0.95,
        ),
      );
    }
    for (const match of matches(SOURCE_LINK_PATTERN, section.body)) {
      const reference = match[1];
      if (reference === undefined) continue;
      const [artifactPath, fragment] = reference.split("#");
      if (artifactPath === undefined) continue;
      claims.push(
        makeClaim(
          page,
          section.id,
          "source_link",
          lineAt(section.body, bodyStart, match.index ?? 0),
          match[0],
          { path: artifactPath, ...(fragment === undefined ? {} : { fragment }) },
          1,
        ),
      );
    }
    for (const match of matches(INLINE_ENTITY_PATTERN, section.body)) {
      const name = match[1];
      if (name === undefined) continue;
      claims.push(
        makeClaim(
          page,
          section.id,
          "entity",
          lineAt(section.body, bodyStart, match.index ?? 0),
          match[0],
          { name: name.replace(/\(\)$/u, "") },
          0.9,
        ),
      );
    }
    for (const match of matches(AMBIGUOUS_ENTITY_PATTERN, section.body)) {
      const name = match[1];
      if (name === undefined) continue;
      claims.push(
        makeClaim(
          page,
          section.id,
          "entity",
          lineAt(section.body, bodyStart, match.index ?? 0),
          match[0],
          { name },
          0.55,
        ),
      );
    }
    for (const match of matches(COMMAND_PATTERN, section.body)) {
      claims.push(
        makeClaim(
          page,
          section.id,
          "command",
          lineAt(section.body, bodyStart, match.index ?? 0),
          match[0],
          { command: match[0].trim() },
          0.95,
        ),
      );
    }
  }
  const unique = new Map(claims.map((claim) => [claim.id, claim]));
  return [...unique.values()].sort(
    (left, right) => left.line - right.line || left.kind.localeCompare(right.kind),
  );
}
