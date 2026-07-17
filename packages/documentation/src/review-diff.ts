import { createHash } from "node:crypto";

export function contentChecksum(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function prefixedLines(prefix: string, value: string): readonly string[] {
  if (value.length === 0) return [];
  return value
    .replace(/\n$/u, "")
    .split("\n")
    .map((line) => `${prefix}${line}`);
}

export function createReviewDiff(path: string, before: string, after: string): string {
  if (before === after) return "";
  const beforeLines = before.length === 0 ? 0 : before.replace(/\n$/u, "").split("\n").length;
  const afterLines = after.length === 0 ? 0 : after.replace(/\n$/u, "").split("\n").length;
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${beforeLines} +1,${afterLines} @@`,
    ...prefixedLines("-", before),
    ...prefixedLines("+", after),
  ].join("\n");
}
