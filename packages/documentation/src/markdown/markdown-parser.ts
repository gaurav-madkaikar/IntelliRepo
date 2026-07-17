import { createHash } from "node:crypto";
import path from "node:path";

import type {
  MarkdownDocumentInput,
  MarkdownPage,
  MarkdownSection,
} from "../documentation-model.js";

export function stableHash(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
}

export function markdownContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function headingTitle(pathname: string): string {
  const base = path.basename(pathname, path.extname(pathname));
  return base
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

interface HeadingMarker {
  readonly heading: string;
  readonly level: number;
  readonly line: number;
}

function headings(lines: readonly string[]): readonly HeadingMarker[] {
  const markers: HeadingMarker[] = [];
  let fence: string | undefined;
  for (const [index, line] of lines.entries()) {
    const fenceMatch = /^\s*(```+|~~~+)/u.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]?.[0];
      fence = fence === undefined ? marker : fence === marker ? undefined : fence;
      continue;
    }
    if (fence !== undefined) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match === null) continue;
    markers.push({
      heading: match[2] ?? "Untitled",
      level: match[1]?.length ?? 1,
      line: index + 1,
    });
  }
  return markers;
}

export function parseMarkdown(
  repositoryId: string,
  revisionId: string,
  document: MarkdownDocumentInput,
): MarkdownPage {
  const lines = document.content.split("\n");
  const markers = headings(lines);
  const pageId = `doc-page:${stableHash(repositoryId, document.path)}`;
  const sections: MarkdownSection[] = [];
  const ancestry: string[] = [];
  const occurrences = new Map<string, number>();
  const firstHeadingLine = markers[0]?.line;
  const hasPreface =
    firstHeadingLine !== undefined &&
    lines.slice(0, firstHeadingLine - 1).some((line) => line.trim().length > 0);
  const effectiveMarkers: readonly HeadingMarker[] =
    markers.length === 0 || hasPreface
      ? [{ heading: "Overview", level: 0, line: 1 }, ...markers]
      : markers;

  for (const [index, marker] of effectiveMarkers.entries()) {
    if (marker.level === 0) ancestry.length = 0;
    else {
      ancestry.length = marker.level - 1;
      ancestry[marker.level - 1] = marker.heading;
    }
    const headingPath = marker.level === 0 ? [marker.heading] : ancestry.slice(0, marker.level);
    const identity = headingPath.join("/").toLocaleLowerCase();
    const occurrence = (occurrences.get(identity) ?? 0) + 1;
    occurrences.set(identity, occurrence);
    const stableKey = `${document.path}#${stableHash(identity, String(occurrence))}`;
    const next = effectiveMarkers[index + 1];
    const lineEnd = next === undefined ? Math.max(lines.length, marker.line) : next.line - 1;
    const contentStart = marker.level === 0 ? marker.line : marker.line + 1;
    sections.push({
      body: lines.slice(contentStart - 1, lineEnd).join("\n"),
      heading: marker.heading,
      headingPath,
      id: `doc-section:${stableHash(pageId, stableKey)}`,
      level: marker.level,
      lineEnd,
      lineStart: marker.line,
      stableKey,
    });
  }

  return {
    contentHash: markdownContentHash(document.content),
    id: pageId,
    path: document.path,
    revisionId,
    sections,
    title: markers.find(({ level }) => level === 1)?.heading ?? headingTitle(document.path),
  };
}
