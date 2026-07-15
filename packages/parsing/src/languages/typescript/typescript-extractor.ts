import ts from "typescript";
import { posix } from "node:path";

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
import type {
  LanguageExtractor,
  LanguageExtractorContext,
} from "../../interfaces/language-extractor.js";
import { makeEntityFact, makeRelationshipFact, type FactContext } from "./fact-factory.js";
import { extractWithTreeSitter } from "./tree-sitter-fallback.js";
import {
  createVirtualTypeScriptProgram,
  ProjectConfigurationError,
  type VirtualTypeScriptProgram,
} from "./virtual-program.js";

interface ArtifactState {
  readonly context: FactContext;
  readonly declarationKeys: Map<ts.Node, EntityStableKey>;
  readonly diagnostics: ExtractionDiagnostic[];
  readonly entities: Map<EntityStableKey, EntityFact>;
  readonly moduleKey: EntityStableKey;
  readonly relationships: RelationshipFact[];
  readonly relationshipFingerprints: Set<string>;
  readonly sourceFile: ts.SourceFile;
  readonly testCallbackKeys: Map<ts.Node, EntityStableKey>;
  readonly unresolvedReferences: UnresolvedReference[];
}

const TEST_FILE_PATTERN = /(?:^|\/)(?:__tests__\/.*|.*\.(?:spec|test))\.[cm]?[jt]sx?$/u;

function sourceRange(sourceFile: ts.SourceFile, node: ts.Node): SourceRange {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return {
    end: { column: end.character + 1, line: end.line + 1 },
    start: { column: start.character + 1, line: start.line + 1 },
  };
}

function diagnosticRange(
  sourceFile: ts.SourceFile,
  diagnostic: ts.Diagnostic,
): SourceRange | undefined {
  if (diagnostic.start === undefined) return undefined;
  const start = sourceFile.getLineAndCharacterOfPosition(diagnostic.start);
  const end = sourceFile.getLineAndCharacterOfPosition(
    diagnostic.start + Math.max(1, diagnostic.length ?? 1),
  );
  return {
    end: { column: end.character + 1, line: end.line + 1 },
    start: { column: start.character + 1, line: start.line + 1 },
  };
}

function declarationName(node: ts.Node): string | undefined {
  if (
    (ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node)) &&
    node.name !== undefined
  ) {
    return node.name.getText(node.getSourceFile());
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return undefined;
}

function declarationNameNode(node: ts.Node): ts.Node | undefined {
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isVariableDeclaration(node)
  ) {
    return node.name;
  }
  return undefined;
}

function qualifiedName(state: ArtifactState, node: ts.Node, name: string): string {
  const parts = [name];
  let parent = node.parent;
  while (parent !== undefined && !ts.isSourceFile(parent)) {
    const parentName = declarationName(parent);
    if (parentName !== undefined) parts.unshift(parentName);
    parent = parent.parent;
  }
  return `${state.context.artifactPath}#${parts.join(".")}`;
}

function modifiers(node: ts.Node): readonly string[] {
  if (!ts.canHaveModifiers(node)) return [];
  return (ts.getModifiers(node) ?? []).map(
    (modifier) =>
      ts.tokenToString(modifier.kind)?.toLowerCase() ?? ts.SyntaxKind[modifier.kind].toLowerCase(),
  );
}

function addRelationship(state: ArtifactState, relationship: RelationshipFact): void {
  const fingerprint = [
    relationship.kind,
    relationship.source,
    relationship.target,
    relationship.provenance.range.start.line,
    relationship.provenance.range.start.column,
  ].join(":");
  if (!state.relationshipFingerprints.has(fingerprint)) {
    state.relationshipFingerprints.add(fingerprint);
    state.relationships.push(relationship);
  }
}

function ownerKey(state: ArtifactState, node: ts.Node): EntityStableKey {
  let current: ts.Node | undefined = node;
  while (current !== undefined && !ts.isSourceFile(current)) {
    const testKey = state.testCallbackKeys.get(current);
    if (testKey !== undefined) return testKey;
    const declarationKey = state.declarationKeys.get(current);
    if (declarationKey !== undefined) return declarationKey;
    current = current.parent;
  }
  return state.moduleKey;
}

function containingDeclarationKey(state: ArtifactState, node: ts.Node): EntityStableKey {
  let current = node.parent;
  while (current !== undefined && !ts.isSourceFile(current)) {
    const key = state.declarationKeys.get(current);
    if (key !== undefined) return key;
    current = current.parent;
  }
  return state.moduleKey;
}

function registerDeclaration(
  state: ArtifactState,
  node: ts.Node,
  entity: EntityFact,
  checker: ts.TypeChecker,
): void {
  state.entities.set(entity.stableKey, entity);
  state.declarationKeys.set(node, entity.stableKey);
  const nameNode = declarationNameNode(node);
  const symbol = nameNode === undefined ? undefined : checker.getSymbolAtLocation(nameNode);
  for (const declaration of symbol?.declarations ?? []) {
    state.declarationKeys.set(declaration, entity.stableKey);
  }
  addRelationship(
    state,
    makeRelationshipFact(state.context, {
      attributes: {},
      evidence: ts.SyntaxKind[node.kind],
      kind: "DECLARES",
      level: "confirmed",
      range: sourceRange(state.sourceFile, node),
      reason: "Direct TypeScript declaration",
      score: 1,
      source: containingDeclarationKey(state, node),
      target: entity.stableKey,
    }),
  );
}

function signature(checker: ts.TypeChecker, node: ts.SignatureDeclaration): string | undefined {
  const value = checker.getSignatureFromDeclaration(node);
  return value === undefined ? undefined : checker.signatureToString(value);
}

function addDeclarations(state: ArtifactState, checker: ts.TypeChecker): void {
  const visit = (node: ts.Node): void => {
    const name = declarationName(node);
    if (name !== undefined) {
      const common = {
        evidence: ts.SyntaxKind[node.kind],
        level: "confirmed" as const,
        name,
        qualifiedName: qualifiedName(state, node, name),
        range: sourceRange(state.sourceFile, node),
        reason: "Direct TypeScript declaration",
        score: 1,
      };
      let entity: EntityFact | undefined;
      if (ts.isClassDeclaration(node)) {
        entity = makeEntityFact(state.context, {
          ...common,
          attributes: { declarationKind: "class", modifiers: modifiers(node) },
          kind: "class",
        });
      } else if (ts.isInterfaceDeclaration(node)) {
        entity = makeEntityFact(state.context, {
          ...common,
          attributes: { modifiers: modifiers(node) },
          kind: "interface",
        });
      } else if (ts.isFunctionDeclaration(node)) {
        const declarationSignature = signature(checker, node);
        entity = makeEntityFact(state.context, {
          ...common,
          attributes: {
            modifiers: modifiers(node),
            ...(declarationSignature === undefined ? {} : { signature: declarationSignature }),
          },
          kind: "function",
        });
      } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
        const declarationSignature = signature(checker, node);
        entity = makeEntityFact(state.context, {
          ...common,
          attributes: {
            modifiers: modifiers(node),
            ...(declarationSignature === undefined ? {} : { signature: declarationSignature }),
          },
          kind: "method",
        });
      } else if (ts.isVariableDeclaration(node)) {
        const initializer = node.initializer;
        if (initializer !== undefined && ts.isFunctionLike(initializer)) {
          const declarationSignature = signature(checker, initializer);
          entity = makeEntityFact(state.context, {
            ...common,
            attributes: {
              ...(declarationSignature === undefined ? {} : { signature: declarationSignature }),
            },
            kind: "function",
          });
        }
      }
      if (entity !== undefined) registerDeclaration(state, node, entity, checker);
    }

    if (ts.isCallExpression(node) && isTestCall(node)) {
      addTestDeclaration(state, node);
    }
    ts.forEachChild(node, visit);
  };
  visit(state.sourceFile);
}

function isTestCall(node: ts.CallExpression): boolean {
  return (
    ts.isIdentifier(node.expression) &&
    (node.expression.text === "it" || node.expression.text === "test") &&
    node.arguments.length >= 2 &&
    (ts.isStringLiteralLike(node.arguments[0] as ts.Expression) ||
      ts.isNoSubstitutionTemplateLiteral(node.arguments[0] as ts.Expression))
  );
}

function addTestDeclaration(state: ArtifactState, node: ts.CallExpression): void {
  const titleNode = node.arguments[0];
  const callback = node.arguments[1];
  if (titleNode === undefined || callback === undefined || !ts.isStringLiteralLike(titleNode))
    return;
  const line = sourceRange(state.sourceFile, node).start.line;
  const entity = makeEntityFact(state.context, {
    attributes: {
      framework: "typescript-test",
      testKind: TEST_FILE_PATTERN.test(state.context.artifactPath) ? "unit" : "unknown",
    },
    evidence: ts.SyntaxKind[node.kind],
    kind: "test",
    level: "confirmed",
    name: titleNode.text,
    qualifiedName: `${state.context.artifactPath}#test:${line}:${titleNode.text}`,
    range: sourceRange(state.sourceFile, node),
    reason: "Direct test declaration",
    score: 1,
  });
  if (!state.entities.has(entity.stableKey)) {
    state.entities.set(entity.stableKey, entity);
    addRelationship(
      state,
      makeRelationshipFact(state.context, {
        attributes: {},
        evidence: ts.SyntaxKind[node.kind],
        kind: "DECLARES",
        level: "confirmed",
        range: sourceRange(state.sourceFile, node),
        reason: "Direct test declaration",
        score: 1,
        source: state.moduleKey,
        target: entity.stableKey,
      }),
    );
  }
  state.testCallbackKeys.set(callback, entity.stableKey);
}

function aliasedSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
): ts.Symbol | undefined {
  if (symbol === undefined) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

function targetKeyForSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol | undefined,
  states: readonly ArtifactState[],
): EntityStableKey | undefined {
  const resolved = aliasedSymbol(checker, symbol);
  for (const declaration of resolved?.declarations ?? []) {
    for (const state of states) {
      const key = state.declarationKeys.get(declaration);
      if (key !== undefined) return key;
    }
  }
  return undefined;
}

function importedName(node: ts.ImportDeclaration | ts.ExportDeclaration): string | undefined {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    const names = [
      ...(clause?.name === undefined ? [] : [clause.name.text]),
      ...(clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
        ? clause.namedBindings.elements.map(({ name }) => name.text)
        : []),
    ];
    return names.length === 0 ? undefined : names.join(",");
  }
  if (node.exportClause !== undefined && ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.map(({ name }) => name.text).join(",");
  }
  return undefined;
}

function addImport(
  state: ArtifactState,
  node: ts.ImportDeclaration | ts.ExportDeclaration,
  checker: ts.TypeChecker,
  states: readonly ArtifactState[],
): void {
  const specifier = node.moduleSpecifier;
  if (specifier === undefined || !ts.isStringLiteralLike(specifier)) return;
  const symbolTarget = targetKeyForSymbol(checker, checker.getSymbolAtLocation(specifier), states);
  const relativeBase = posix.normalize(
    posix.join(posix.dirname(state.context.artifactPath), specifier.text),
  );
  const relativeCandidates = [
    relativeBase,
    `${relativeBase}.ts`,
    `${relativeBase}.tsx`,
    `${relativeBase}.js`,
    `${relativeBase}.jsx`,
    posix.join(relativeBase, "index.ts"),
    posix.join(relativeBase, "index.tsx"),
  ];
  const pathTarget = states.find(({ context }) =>
    relativeCandidates.includes(context.artifactPath),
  )?.moduleKey;
  const target = symbolTarget ?? pathTarget;
  const range = sourceRange(state.sourceFile, node);
  if (target === undefined) {
    state.unresolvedReferences.push({
      artifactPath: state.context.artifactPath,
      candidateEntityKeys: [],
      kind: "import",
      name: specifier.text,
      range,
      sourceEntityKey: state.moduleKey,
    });
    state.diagnostics.push(
      createDiagnostic({
        artifactPath: state.context.artifactPath,
        code: "TS_UNRESOLVED_IMPORT",
        message: `Import ${specifier.text} could not be resolved inside the repository`,
        range,
        severity: "information",
      }),
    );
    return;
  }
  const name = importedName(node);
  addRelationship(
    state,
    makeRelationshipFact(state.context, {
      attributes: name === undefined ? {} : { importedName: name },
      evidence: ts.SyntaxKind[node.kind],
      kind: "IMPORTS",
      level: "inferred",
      range,
      reason: "TypeScript module symbol resolved",
      score: 0.92,
      source: state.moduleKey,
      target,
    }),
  );
}

function callName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return expression.getText(expression.getSourceFile());
}

function symbolForCall(checker: ts.TypeChecker, expression: ts.LeftHandSideExpression) {
  return checker.getSymbolAtLocation(
    ts.isPropertyAccessExpression(expression) ? expression.name : expression,
  );
}

function entityCandidates(states: readonly ArtifactState[], name: string): readonly EntityFact[] {
  return states.flatMap((state) =>
    [...state.entities.values()].filter(
      (entity) =>
        entity.name === name &&
        (entity.kind === "function" || entity.kind === "method" || entity.kind === "class"),
    ),
  );
}

function addCall(
  state: ArtifactState,
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  states: readonly ArtifactState[],
): void {
  if (isTestCall(node)) return;
  const source = ownerKey(state, node);
  const name = callName(node.expression);
  const symbolTarget = targetKeyForSymbol(checker, symbolForCall(checker, node.expression), states);
  const candidates = entityCandidates(states, name);
  const target = symbolTarget ?? (candidates.length === 1 ? candidates[0]?.stableKey : undefined);
  const range = sourceRange(state.sourceFile, node);

  if (target === undefined) {
    state.unresolvedReferences.push({
      artifactPath: state.context.artifactPath,
      candidateEntityKeys: candidates.map(({ stableKey }) => stableKey),
      kind: "call",
      name,
      range,
      sourceEntityKey: source,
    });
    state.diagnostics.push(
      createDiagnostic({
        artifactPath: state.context.artifactPath,
        ...(candidates.length === 0
          ? {}
          : { candidateEntityKeys: candidates.map(({ stableKey }) => stableKey) }),
        code: candidates.length > 1 ? "TS_AMBIGUOUS_CALL" : "TS_UNRESOLVED_CALL",
        message:
          candidates.length > 1
            ? `Call ${name} matches ${candidates.length} repository symbols`
            : `Call ${name} could not be resolved inside the repository`,
        range,
        severity: candidates.length > 1 ? "warning" : "information",
      }),
    );
    return;
  }

  const resolvedBySymbol = symbolTarget !== undefined;
  const sourceEntity = states
    .flatMap(({ entities }) => [...entities.values()])
    .find(({ stableKey }) => stableKey === source);
  if (sourceEntity?.kind === "test") {
    addRelationship(
      state,
      makeRelationshipFact(state.context, {
        attributes: { basis: "call" },
        evidence: ts.SyntaxKind[node.kind],
        kind: "TESTS",
        level: resolvedBySymbol ? "inferred" : "tentative",
        range,
        reason: resolvedBySymbol ? "TypeScript call symbol resolved" : "Unique name match",
        score: resolvedBySymbol ? 0.9 : 0.4,
        source,
        target,
      }),
    );
  } else {
    addRelationship(
      state,
      makeRelationshipFact(state.context, {
        attributes: { resolution: resolvedBySymbol ? "symbol" : "name" },
        evidence: ts.SyntaxKind[node.kind],
        kind: "CALLS",
        level: resolvedBySymbol ? "inferred" : "tentative",
        range,
        reason: resolvedBySymbol ? "TypeScript call symbol resolved" : "Unique name match",
        score: resolvedBySymbol ? 0.9 : 0.4,
        source,
        target,
      }),
    );
  }
}

function environmentVariable(node: ts.Node): { name: string; rangeNode: ts.Node } | undefined {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "env"
  ) {
    return { name: node.name.text, rangeNode: node };
  }
  if (
    ts.isElementAccessExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "process" &&
    node.expression.name.text === "env" &&
    node.argumentExpression !== undefined &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return { name: node.argumentExpression.text, rangeNode: node };
  }
  return undefined;
}

function addEnvironmentVariable(state: ArtifactState, node: ts.Node): boolean {
  const environment = environmentVariable(node);
  if (environment === undefined) return false;
  const range = sourceRange(state.sourceFile, environment.rangeNode);
  const entity = makeEntityFact(state.context, {
    attributes: { name: environment.name },
    evidence: ts.SyntaxKind[node.kind],
    kind: "environment_variable",
    level: "confirmed",
    name: environment.name,
    qualifiedName: `${state.context.artifactPath}#env.${environment.name}`,
    range,
    reason: "Direct process.env access",
    score: 1,
  });
  state.entities.set(entity.stableKey, entity);
  addRelationship(
    state,
    makeRelationshipFact(state.context, {
      attributes: { access: "direct" },
      evidence: ts.SyntaxKind[node.kind],
      kind: "READS_CONFIG",
      level: "confirmed",
      range,
      reason: "Direct process.env access",
      score: 1,
      source: ownerKey(state, node),
      target: entity.stableKey,
    }),
  );
  return true;
}

function addHeritage(
  state: ArtifactState,
  node: ts.ClassDeclaration | ts.InterfaceDeclaration,
  checker: ts.TypeChecker,
  states: readonly ArtifactState[],
): void {
  const source = state.declarationKeys.get(node);
  if (source === undefined) return;
  for (const clause of node.heritageClauses ?? []) {
    for (const type of clause.types) {
      const target = targetKeyForSymbol(
        checker,
        checker.getSymbolAtLocation(type.expression),
        states,
      );
      const range = sourceRange(state.sourceFile, type);
      if (target === undefined) {
        state.unresolvedReferences.push({
          artifactPath: state.context.artifactPath,
          candidateEntityKeys: [],
          kind: "heritage",
          name: type.expression.getText(state.sourceFile),
          range,
          sourceEntityKey: source,
        });
        continue;
      }
      const kind = clause.token === ts.SyntaxKind.ImplementsKeyword ? "IMPLEMENTS" : "EXTENDS";
      addRelationship(
        state,
        makeRelationshipFact(state.context, {
          attributes: {},
          evidence: ts.SyntaxKind[clause.token],
          kind,
          level: "inferred",
          range,
          reason: "TypeScript heritage symbol resolved",
          score: 0.92,
          source,
          target,
        }),
      );
    }
  }
}

function addRelationships(
  state: ArtifactState,
  checker: ts.TypeChecker,
  states: readonly ArtifactState[],
): void {
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addImport(state, node, checker, states);
    }
    if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
      addHeritage(state, node, checker, states);
    }
    const wasEnvironmentVariable = addEnvironmentVariable(state, node);
    if (!wasEnvironmentVariable && ts.isCallExpression(node)) {
      addCall(state, node, checker, states);
    }
    ts.forEachChild(node, visit);
  };
  visit(state.sourceFile);
}

function createState(
  context: LanguageExtractorContext,
  virtualProgram: VirtualTypeScriptProgram,
  sourceFile: ts.SourceFile,
  artifactPath: string,
): ArtifactState {
  const factContext = {
    artifactPath,
    repositoryId: context.repositoryId,
    revisionId: context.revisionId,
  };
  const moduleEntity = makeEntityFact(factContext, {
    attributes: { path: artifactPath },
    evidence: "SourceFile",
    kind: "module",
    level: "confirmed",
    name: artifactPath,
    qualifiedName: artifactPath,
    range: sourceRange(sourceFile, sourceFile),
    reason: "TypeScript source artifact",
    score: 1,
  });
  const state: ArtifactState = {
    context: factContext,
    declarationKeys: new Map([[sourceFile, moduleEntity.stableKey]]),
    diagnostics: [],
    entities: new Map([[moduleEntity.stableKey, moduleEntity]]),
    moduleKey: moduleEntity.stableKey,
    relationships: [],
    relationshipFingerprints: new Set(),
    sourceFile,
    testCallbackKeys: new Map(),
    unresolvedReferences: [],
  };
  for (const diagnostic of virtualProgram.program.getSyntacticDiagnostics(sourceFile)) {
    const range = diagnosticRange(sourceFile, diagnostic);
    state.diagnostics.push(
      createDiagnostic({
        artifactPath,
        code: `TS${diagnostic.code}`,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        ...(range === undefined ? {} : { range }),
        severity: "error",
      }),
    );
  }
  return state;
}

function toResult(state: ArtifactState): ArtifactExtractionResult {
  return Object.freeze({
    artifactPath: state.context.artifactPath,
    diagnostics: Object.freeze(state.diagnostics),
    entities: Object.freeze([...state.entities.values()]),
    mode: "semantic",
    relationships: Object.freeze(state.relationships),
    unresolvedReferences: Object.freeze(state.unresolvedReferences),
  });
}

export class TypeScriptExtractor implements LanguageExtractor {
  public readonly id = "typescript-compiler-api";
  public readonly language = "typescript" as const;

  public supports(artifact: SourceArtifactInput): boolean {
    return /\.[cm]?[jt]sx?$/u.test(artifact.path);
  }

  public async extract(
    context: LanguageExtractorContext,
  ): Promise<readonly ArtifactExtractionResult[]> {
    try {
      const virtualProgram = createVirtualTypeScriptProgram(context.artifacts);
      const states = [...virtualProgram.artifactPathByFileName.entries()].flatMap(
        ([fileName, artifactPath]) => {
          const sourceFile = virtualProgram.program.getSourceFile(fileName);
          return sourceFile === undefined
            ? []
            : [createState(context, virtualProgram, sourceFile, artifactPath)];
        },
      );
      for (const state of states) addDeclarations(state, virtualProgram.checker);
      for (const state of states) addRelationships(state, virtualProgram.checker, states);
      return states.map(toResult);
    } catch (error) {
      if (!(error instanceof ProjectConfigurationError)) throw error;
      return extractWithTreeSitter(context, error.message);
    }
  }
}
