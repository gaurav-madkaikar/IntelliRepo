import type { Node as SyntaxNode } from "web-tree-sitter-legacy";

import type { SourceRange } from "@intellirepo/domain";

import { createDiagnostic, type ExtractionDiagnostic } from "../../diagnostics/diagnostic.js";

export function syntaxRange(node: SyntaxNode): SourceRange {
  return {
    end: { column: node.endPosition.column + 1, line: node.endPosition.row + 1 },
    start: { column: node.startPosition.column + 1, line: node.startPosition.row + 1 },
  };
}

export function namedDescendants(
  node: SyntaxNode,
  types: string | readonly string[],
): readonly SyntaxNode[] {
  return node
    .descendantsOfType(typeof types === "string" ? types : [...types])
    .filter((candidate): candidate is SyntaxNode => candidate !== null);
}

export function firstNamedChild(
  node: SyntaxNode,
  types: readonly string[],
): SyntaxNode | undefined {
  return node.namedChildren.find(
    (candidate): candidate is SyntaxNode => candidate !== null && types.includes(candidate.type),
  );
}

export function directNamedChildren(
  node: SyntaxNode,
  types: readonly string[],
): readonly SyntaxNode[] {
  return node.namedChildren.filter(
    (candidate): candidate is SyntaxNode => candidate !== null && types.includes(candidate.type),
  );
}

export function identifierText(node: SyntaxNode): string | undefined {
  return (
    node.childForFieldName("name")?.text ??
    firstNamedChild(node, ["identifier", "type_identifier", "simple_identifier"])?.text
  );
}

export function syntaxDiagnostics(
  artifactPath: string,
  root: SyntaxNode,
  language: "java" | "kotlin",
): readonly ExtractionDiagnostic[] {
  if (!root.hasError) return [];
  const errors = namedDescendants(root, ["ERROR"]);
  const diagnostics = errors.map((node) =>
    createDiagnostic({
      artifactPath,
      code: `${language.toUpperCase()}_SYNTAX_ERROR`,
      message: `Tree-sitter recovered from invalid ${language} syntax`,
      range: syntaxRange(node),
      severity: "error",
    }),
  );
  return diagnostics.length === 0
    ? [
        createDiagnostic({
          artifactPath,
          code: `${language.toUpperCase()}_SYNTAX_ERROR`,
          message: `Tree-sitter recovered from invalid ${language} syntax`,
          range: syntaxRange(root),
          severity: "error",
        }),
      ]
    : diagnostics;
}
