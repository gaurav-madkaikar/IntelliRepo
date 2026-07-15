import { createRequire } from "node:module";
import { posix } from "node:path";

import { Language, Node as SyntaxNode, Parser, type Tree } from "web-tree-sitter";

import type {
  EntityFact,
  EntityStableKey,
  RelationshipFact,
  SourceRange,
} from "@intellirepo/domain";

import { createDiagnostic, type ExtractionDiagnostic } from "../../diagnostics/diagnostic.js";
import type {
  ArtifactExtractionResult,
  SourceArtifactInput,
  UnresolvedReference,
} from "../../interfaces/extraction.js";
import type { LanguageExtractorContext } from "../../interfaces/language-extractor.js";
import { makeEntityFact, makeRelationshipFact, type FactContext } from "./fact-factory.js";

const require = createRequire(import.meta.url);
let parserInitialization: Promise<Language> | undefined;

interface FallbackState {
  readonly artifact: SourceArtifactInput;
  readonly context: FactContext;
  readonly declarationKeys: Map<number, EntityStableKey>;
  readonly diagnostics: ExtractionDiagnostic[];
  readonly entities: Map<EntityStableKey, EntityFact>;
  readonly moduleKey: EntityStableKey;
  readonly relationships: RelationshipFact[];
  readonly tree: Tree;
  readonly unresolvedReferences: UnresolvedReference[];
}

function range(node: SyntaxNode): SourceRange {
  return {
    end: { column: node.endPosition.column + 1, line: node.endPosition.row + 1 },
    start: { column: node.startPosition.column + 1, line: node.startPosition.row + 1 },
  };
}

async function typeScriptLanguage(): Promise<Language> {
  parserInitialization ??= (async () => {
    await Parser.init();
    const wasmPath = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm");
    return Language.load(wasmPath);
  })();
  return parserInitialization;
}

async function parse(content: string): Promise<Tree> {
  const language = await typeScriptLanguage();
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(content);
  parser.delete();
  if (tree === null) throw new Error("Tree-sitter returned no syntax tree");
  return tree;
}

function declarationKind(
  node: SyntaxNode,
): "class" | "function" | "interface" | "method" | undefined {
  if (node.type === "class_declaration") return "class";
  if (node.type === "interface_declaration") return "interface";
  if (node.type === "function_declaration") return "function";
  if (node.type === "method_definition") return "method";
  if (node.type === "variable_declarator") {
    const value = node.childForFieldName("value");
    if (value?.type === "arrow_function" || value?.type === "function_expression")
      return "function";
  }
  return undefined;
}

function declarationName(node: SyntaxNode): string | undefined {
  return node.childForFieldName("name")?.text;
}

function declarationQualifiedName(state: FallbackState, node: SyntaxNode, name: string): string {
  const parts = [name];
  let parent = node.parent;
  while (parent !== null) {
    if (declarationKind(parent) !== undefined) {
      const parentName = declarationName(parent);
      if (parentName !== undefined) parts.unshift(parentName);
    }
    parent = parent.parent;
  }
  return `${state.artifact.path}#${parts.join(".")}`;
}

function ownerKey(state: FallbackState, node: SyntaxNode): EntityStableKey {
  let current: SyntaxNode | null = node;
  while (current !== null) {
    const key = state.declarationKeys.get(current.id);
    if (key !== undefined) return key;
    current = current.parent;
  }
  return state.moduleKey;
}

function addRelationship(state: FallbackState, relationship: RelationshipFact): void {
  const duplicate = state.relationships.some(
    (candidate) =>
      candidate.kind === relationship.kind &&
      candidate.source === relationship.source &&
      candidate.target === relationship.target &&
      candidate.provenance.range.start.line === relationship.provenance.range.start.line &&
      candidate.provenance.range.start.column === relationship.provenance.range.start.column,
  );
  if (!duplicate) state.relationships.push(relationship);
}

function addDeclarations(state: FallbackState): void {
  const nodes = state.tree.rootNode.descendantsOfType([
    "class_declaration",
    "interface_declaration",
    "function_declaration",
    "method_definition",
    "variable_declarator",
  ]);
  for (const node of nodes) {
    const kind = declarationKind(node);
    const name = declarationName(node);
    if (kind === undefined || name === undefined) continue;
    const common = {
      evidence: node.type,
      level: "confirmed" as const,
      name,
      qualifiedName: declarationQualifiedName(state, node, name),
      range: range(node),
      reason: "Direct Tree-sitter declaration",
      score: 1,
    };
    const entity =
      kind === "class"
        ? makeEntityFact(state.context, {
            ...common,
            attributes: { declarationKind: "class" },
            kind,
          })
        : makeEntityFact(state.context, {
            ...common,
            attributes: {},
            kind,
          });
    state.entities.set(entity.stableKey, entity);
    state.declarationKeys.set(node.id, entity.stableKey);
    addRelationship(
      state,
      makeRelationshipFact(state.context, {
        attributes: {},
        evidence: node.type,
        kind: "DECLARES",
        level: "confirmed",
        range: range(node),
        reason: "Direct Tree-sitter declaration",
        score: 1,
        source: ownerKey(state, node.parent ?? node),
        target: entity.stableKey,
      }),
    );
  }
}

function localModuleTarget(
  state: FallbackState,
  specifier: string,
  states: readonly FallbackState[],
): EntityStableKey | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = posix.normalize(posix.join(posix.dirname(state.artifact.path), specifier));
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    posix.join(base, "index.ts"),
    posix.join(base, "index.tsx"),
  ];
  return states.find(({ artifact }) => candidates.includes(artifact.path))?.moduleKey;
}

function importSpecifier(node: SyntaxNode): string | undefined {
  const match = /\bfrom\s+["']([^"']+)["']|\bimport\s+["']([^"']+)["']/u.exec(node.text);
  return match?.[1] ?? match?.[2];
}

function addImports(state: FallbackState, states: readonly FallbackState[]): void {
  for (const node of state.tree.rootNode.descendantsOfType([
    "import_statement",
    "export_statement",
  ])) {
    const specifier = importSpecifier(node);
    if (specifier === undefined) continue;
    const target = localModuleTarget(state, specifier, states);
    if (target === undefined) {
      state.unresolvedReferences.push({
        artifactPath: state.artifact.path,
        candidateEntityKeys: [],
        kind: "import",
        name: specifier,
        range: range(node),
        sourceEntityKey: state.moduleKey,
      });
      continue;
    }
    addRelationship(
      state,
      makeRelationshipFact(state.context, {
        attributes: {},
        evidence: node.type,
        kind: "IMPORTS",
        level: "inferred",
        range: range(node),
        reason: "Relative module path resolved by Tree-sitter fallback",
        score: 0.75,
        source: state.moduleKey,
        target,
      }),
    );
  }
}

function callableName(node: SyntaxNode): string {
  const functionNode = node.childForFieldName("function") ?? node.firstNamedChild;
  if (functionNode === null) return node.text;
  const property = functionNode.descendantsOfType(["property_identifier", "identifier"]);
  return property.at(-1)?.text ?? functionNode.text;
}

function callableCandidates(states: readonly FallbackState[], name: string): readonly EntityFact[] {
  return states.flatMap((state) =>
    [...state.entities.values()].filter(
      (entity) => entity.name === name && (entity.kind === "function" || entity.kind === "method"),
    ),
  );
}

function addCalls(state: FallbackState, states: readonly FallbackState[]): void {
  for (const node of state.tree.rootNode.descendantsOfType("call_expression")) {
    const name = callableName(node);
    if (name === "it" || name === "test" || name === "describe") continue;
    const candidates = callableCandidates(states, name);
    const source = ownerKey(state, node);
    const nodeRange = range(node);
    if (candidates.length === 1 && candidates[0] !== undefined) {
      addRelationship(
        state,
        makeRelationshipFact(state.context, {
          attributes: { resolution: "name" },
          evidence: node.type,
          kind: "CALLS",
          level: "tentative",
          range: nodeRange,
          reason: "Tree-sitter fallback unique name match",
          score: 0.4,
          source,
          target: candidates[0].stableKey,
        }),
      );
      state.diagnostics.push(
        createDiagnostic({
          artifactPath: state.artifact.path,
          candidateEntityKeys: [candidates[0].stableKey],
          code: "TS_FALLBACK_NAME_RESOLUTION",
          message: `Call ${name} was matched by name without type information`,
          range: nodeRange,
          severity: "warning",
        }),
      );
      continue;
    }
    state.unresolvedReferences.push({
      artifactPath: state.artifact.path,
      candidateEntityKeys: candidates.map(({ stableKey }) => stableKey),
      kind: "call",
      name,
      range: nodeRange,
      sourceEntityKey: source,
    });
    state.diagnostics.push(
      createDiagnostic({
        artifactPath: state.artifact.path,
        ...(candidates.length === 0
          ? {}
          : { candidateEntityKeys: candidates.map(({ stableKey }) => stableKey) }),
        code: candidates.length > 1 ? "TS_AMBIGUOUS_CALL" : "TS_UNRESOLVED_CALL",
        message:
          candidates.length > 1
            ? `Fallback call ${name} matches ${candidates.length} symbols`
            : `Fallback call ${name} has no repository-local target`,
        range: nodeRange,
        severity: candidates.length > 1 ? "warning" : "information",
      }),
    );
  }
}

function addEnvironmentVariables(state: FallbackState): void {
  for (const node of state.tree.rootNode.descendantsOfType("member_expression")) {
    const match = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/u.exec(node.text);
    const name = match?.[1];
    if (name === undefined) continue;
    const entity = makeEntityFact(state.context, {
      attributes: { name },
      evidence: node.type,
      kind: "environment_variable",
      level: "confirmed",
      name,
      qualifiedName: `${state.artifact.path}#env.${name}`,
      range: range(node),
      reason: "Direct process.env syntax",
      score: 1,
    });
    state.entities.set(entity.stableKey, entity);
    addRelationship(
      state,
      makeRelationshipFact(state.context, {
        attributes: { access: "direct" },
        evidence: node.type,
        kind: "READS_CONFIG",
        level: "confirmed",
        range: range(node),
        reason: "Direct process.env syntax",
        score: 1,
        source: ownerKey(state, node),
        target: entity.stableKey,
      }),
    );
  }
}

async function createState(
  context: LanguageExtractorContext,
  artifact: SourceArtifactInput,
  fallbackReason: string,
): Promise<FallbackState> {
  const tree = await parse(artifact.content);
  const factContext = {
    artifactPath: artifact.path,
    repositoryId: context.repositoryId,
    revisionId: context.revisionId,
  };
  const moduleEntity = makeEntityFact(factContext, {
    attributes: { path: artifact.path },
    evidence: "program",
    kind: "module",
    level: "confirmed",
    name: artifact.path,
    qualifiedName: artifact.path,
    range: range(tree.rootNode),
    reason: "Tree-sitter source artifact",
    score: 1,
  });
  const diagnostics = [
    createDiagnostic({
      artifactPath: artifact.path,
      code: "TS_PROJECT_CONFIG_FALLBACK",
      message: `Tree-sitter fallback used: ${fallbackReason}`,
      severity: "warning",
    }),
  ];
  if (tree.rootNode.hasError) {
    diagnostics.push(
      createDiagnostic({
        artifactPath: artifact.path,
        code: "TS_FALLBACK_SYNTAX_ERROR",
        message: "Tree-sitter recovered from incomplete TypeScript syntax",
        range: range(tree.rootNode),
        severity: "warning",
      }),
    );
  }
  return {
    artifact,
    context: factContext,
    declarationKeys: new Map([[tree.rootNode.id, moduleEntity.stableKey]]),
    diagnostics,
    entities: new Map([[moduleEntity.stableKey, moduleEntity]]),
    moduleKey: moduleEntity.stableKey,
    relationships: [],
    tree,
    unresolvedReferences: [],
  };
}

function toResult(state: FallbackState): ArtifactExtractionResult {
  return Object.freeze({
    artifactPath: state.artifact.path,
    diagnostics: Object.freeze(state.diagnostics),
    entities: Object.freeze([...state.entities.values()]),
    mode: "syntax-fallback",
    relationships: Object.freeze(state.relationships),
    unresolvedReferences: Object.freeze(state.unresolvedReferences),
  });
}

export async function extractWithTreeSitter(
  context: LanguageExtractorContext,
  fallbackReason: string,
): Promise<readonly ArtifactExtractionResult[]> {
  const artifacts = context.artifacts.filter(({ path }) => /\.[cm]?[jt]sx?$/u.test(path));
  const states = await Promise.all(
    artifacts.map((artifact) => createState(context, artifact, fallbackReason)),
  );
  for (const state of states) addDeclarations(state);
  for (const state of states) {
    addImports(state, states);
    addEnvironmentVariables(state);
    addCalls(state, states);
  }
  const results = states.map(toResult);
  for (const state of states) state.tree.delete();
  return results;
}
