import type { Node as SyntaxNode, Tree } from "web-tree-sitter-legacy";

import type { EntityFact, EntityStableKey, RelationshipFact } from "@intellirepo/domain";

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
import {
  makeJvmEntityFact,
  makeJvmRelationshipFact,
  type JvmFactContext,
} from "../jvm/fact-factory.js";
import { JvmSymbolIndex, type ImportBinding } from "../jvm/symbol-index.js";
import {
  directNamedChildren,
  firstNamedChild,
  identifierText,
  namedDescendants,
  syntaxDiagnostics,
  syntaxRange,
} from "../jvm/syntax.js";
import { parseJvmSource } from "../jvm/tree-sitter-runtime.js";

const TYPE_NODES = [
  "class_declaration",
  "interface_declaration",
  "record_declaration",
  "enum_declaration",
] as const;
const MEMBER_NODES = [
  "field_declaration",
  "constructor_declaration",
  "method_declaration",
] as const;

interface JavaState {
  readonly artifact: SourceArtifactInput;
  readonly context: JvmFactContext;
  readonly declarationKeys: Map<number, EntityStableKey>;
  readonly diagnostics: ExtractionDiagnostic[];
  readonly entities: Map<EntityStableKey, EntityFact>;
  readonly imports: readonly ImportBinding[];
  readonly moduleKey: EntityStableKey;
  readonly packageName: string;
  readonly relationships: RelationshipFact[];
  readonly relationshipFingerprints: Set<string>;
  readonly testKeys: Map<number, EntityStableKey>;
  readonly tree: Tree;
  readonly unresolvedReferences: UnresolvedReference[];
}

function packageName(root: SyntaxNode): string {
  const declaration = firstNamedChild(root, ["package_declaration"]);
  return (
    declaration?.text
      .replace(/^package\s+/u, "")
      .replace(/;$/u, "")
      .trim() ?? ""
  );
}

function importBinding(node: SyntaxNode): ImportBinding | undefined {
  const match = /^import\s+(static\s+)?([^;]+);?$/u.exec(node.text.trim());
  if (match?.[2] === undefined) return undefined;
  const raw = match[2].trim();
  return {
    isStatic: match[1] !== undefined,
    qualifiedName: raw.replace(/\.\*$/u, ""),
    wildcard: raw.endsWith(".*"),
  };
}

function imports(root: SyntaxNode): readonly ImportBinding[] {
  return directNamedChildren(root, ["import_declaration"]).flatMap((node) => {
    const binding = importBinding(node);
    return binding === undefined ? [] : [binding];
  });
}

function modifiers(node: SyntaxNode): readonly string[] {
  const modifierNode = firstNamedChild(node, ["modifiers"]);
  if (modifierNode === undefined) return [];
  return modifierNode.children
    .filter((child): child is SyntaxNode => child !== null && child.isNamed === false)
    .map(({ text }) => text.trim())
    .filter((value) => value.length > 0);
}

function visibility(values: readonly string[]) {
  if (values.includes("public")) return "public" as const;
  if (values.includes("protected")) return "protected" as const;
  if (values.includes("private")) return "private" as const;
  return "package" as const;
}

function enclosingTypeNodes(node: SyntaxNode): readonly SyntaxNode[] {
  const result: SyntaxNode[] = [];
  let parent = node.parent;
  while (parent !== null) {
    if ((TYPE_NODES as readonly string[]).includes(parent.type)) result.unshift(parent);
    parent = parent.parent;
  }
  return result;
}

function typeQualifiedName(state: JavaState, node: SyntaxNode, name: string): string {
  const parents = enclosingTypeNodes(node)
    .map(identifierText)
    .filter((value): value is string => value !== undefined);
  return [...(state.packageName.length === 0 ? [] : [state.packageName]), ...parents, name].join(
    ".",
  );
}

function ownerQualifiedName(state: JavaState, node: SyntaxNode): string {
  const owner = enclosingTypeNodes(node).at(-1);
  if (owner === undefined) return state.artifact.path;
  const name = identifierText(owner) ?? "anonymous";
  return typeQualifiedName(state, owner, name);
}

function parameters(node: SyntaxNode): readonly SyntaxNode[] {
  const list = node.childForFieldName("parameters") ?? firstNamedChild(node, ["formal_parameters"]);
  return list === undefined || list === null
    ? []
    : directNamedChildren(list, ["formal_parameter", "spread_parameter", "receiver_parameter"]);
}

function parameterSignature(node: SyntaxNode): string {
  const type =
    node.childForFieldName("type")?.text ??
    firstNamedChild(node, ["type_identifier", "generic_type", "array_type"])?.text;
  return type?.replace(/\s+/gu, "") ?? "?";
}

function memberQualifiedName(state: JavaState, node: SyntaxNode, name: string): string {
  const signature = parameters(node).map(parameterSignature).join(",");
  return `${ownerQualifiedName(state, node)}.${name}(${signature})`;
}

function ownerKey(state: JavaState, node: SyntaxNode): EntityStableKey {
  let current: SyntaxNode | null = node;
  while (current !== null) {
    const test = state.testKeys.get(current.id);
    if (test !== undefined) return test;
    const declaration = state.declarationKeys.get(current.id);
    if (declaration !== undefined) return declaration;
    current = current.parent;
  }
  return state.moduleKey;
}

function declarationOwnerKey(state: JavaState, node: SyntaxNode): EntityStableKey {
  let current = node.parent;
  while (current !== null) {
    const key = state.declarationKeys.get(current.id);
    if (key !== undefined) return key;
    current = current.parent;
  }
  return state.moduleKey;
}

function addRelationship(state: JavaState, relationship: RelationshipFact): void {
  const fingerprint = `${relationship.kind}:${relationship.source}:${relationship.target}:${relationship.provenance.range.start.line}:${relationship.provenance.range.start.column}`;
  if (!state.relationshipFingerprints.has(fingerprint)) {
    state.relationshipFingerprints.add(fingerprint);
    state.relationships.push(relationship);
  }
}

function declare(state: JavaState, node: SyntaxNode, entity: EntityFact): void {
  state.entities.set(entity.stableKey, entity);
  state.declarationKeys.set(node.id, entity.stableKey);
  addRelationship(
    state,
    makeJvmRelationshipFact(state.context, {
      attributes: {},
      evidence: node.type,
      kind: "DECLARES",
      level: "confirmed",
      range: syntaxRange(node),
      reason: "Direct Java declaration",
      score: 1,
      source: declarationOwnerKey(state, node),
      target: entity.stableKey,
    }),
  );
}

function addTypes(state: JavaState, index: JvmSymbolIndex): void {
  for (const node of namedDescendants(state.tree.rootNode, TYPE_NODES)) {
    const name = identifierText(node);
    if (name === undefined) continue;
    const common = {
      evidence: node.type,
      level: "confirmed" as const,
      name,
      qualifiedName: typeQualifiedName(state, node, name),
      range: syntaxRange(node),
      reason: "Direct Java type declaration",
      score: 1,
    };
    const values = modifiers(node);
    const entity =
      node.type === "interface_declaration"
        ? makeJvmEntityFact(state.context, {
            ...common,
            attributes: { modifiers: values, visibility: visibility(values) },
            kind: "interface",
          })
        : makeJvmEntityFact(state.context, {
            ...common,
            attributes: {
              declarationKind:
                node.type === "record_declaration"
                  ? "record"
                  : node.type === "enum_declaration"
                    ? "enum"
                    : "class",
              modifiers: values,
              visibility: visibility(values),
            },
            kind: "class",
          });
    declare(state, node, entity);
    index.add({ entity, language: "java", packageName: state.packageName });
  }
}

function annotations(node: SyntaxNode): readonly SyntaxNode[] {
  const modifierNode = firstNamedChild(node, ["modifiers"]);
  return modifierNode === undefined
    ? []
    : namedDescendants(modifierNode, ["annotation", "marker_annotation"]);
}

function annotationName(node: SyntaxNode): string {
  return (
    node.childForFieldName("name")?.text ??
    node.text.replace(/^@/u, "").split("(")[0]?.trim() ??
    node.text
  );
}

function addAnnotations(
  state: JavaState,
  node: SyntaxNode,
  owner: EntityStableKey,
  ownerName: string,
): void {
  for (const annotation of annotations(node)) {
    const name = annotationName(annotation);
    const range = syntaxRange(annotation);
    const args = /\((.*)\)$/su.exec(annotation.text)?.[1]?.trim();
    const entity = makeJvmEntityFact(state.context, {
      attributes: {
        ...(args === undefined || args.length === 0 ? {} : { arguments: args }),
        annotationName: name,
      },
      evidence: annotation.type,
      kind: "annotation",
      level: "confirmed",
      name,
      qualifiedName: `${ownerName}#@${name}:${range.start.line}:${range.start.column}`,
      range,
      reason: "Direct Java annotation",
      score: 1,
    });
    state.entities.set(entity.stableKey, entity);
    addRelationship(
      state,
      makeJvmRelationshipFact(state.context, {
        attributes: {},
        evidence: annotation.type,
        kind: "DECLARES",
        level: "confirmed",
        range,
        reason: "Direct Java annotation",
        score: 1,
        source: owner,
        target: entity.stableKey,
      }),
    );
    const configurationKey = /\$\{([^}:]+)(?::[^}]*)?\}/u.exec(annotation.text)?.[1]?.trim();
    if (configurationKey !== undefined && configurationKey.length > 0) {
      state.unresolvedReferences.push({
        artifactPath: state.artifact.path,
        candidateEntityKeys: [],
        kind: "configuration",
        name: configurationKey,
        range,
        sourceEntityKey: owner,
      });
    }
  }
}

function isTestMethod(node: SyntaxNode, state: JavaState): boolean {
  return (
    annotations(node).some((annotation) => /(?:^|\.)Test$/u.test(annotationName(annotation))) ||
    /(?:^|\/).*Test\.java$/u.test(state.artifact.path)
  );
}

function addMembers(state: JavaState, index: JvmSymbolIndex): void {
  for (const node of namedDescendants(state.tree.rootNode, MEMBER_NODES)) {
    if (node.type === "field_declaration") {
      const type = node.childForFieldName("type")?.text;
      for (const declarator of directNamedChildren(node, ["variable_declarator"])) {
        const name = identifierText(declarator);
        if (name === undefined) continue;
        const values = modifiers(node);
        const entity = makeJvmEntityFact(state.context, {
          attributes: {
            modifiers: values,
            ...(type === undefined ? {} : { type }),
            visibility: visibility(values),
          },
          evidence: node.type,
          kind: "field",
          level: "confirmed",
          name,
          qualifiedName: `${ownerQualifiedName(state, node)}.${name}`,
          range: syntaxRange(declarator),
          reason: "Direct Java field declaration",
          score: 1,
        });
        declare(state, declarator, entity);
      }
      continue;
    }

    const name = identifierText(node);
    if (name === undefined) continue;
    const values = modifiers(node);
    const qualifiedName = memberQualifiedName(state, node, name);
    const signature = `${name}(${parameters(node).map(parameterSignature).join(",")})`;
    const kind = node.type === "constructor_declaration" ? "constructor" : "method";
    const entity = makeJvmEntityFact(state.context, {
      attributes: { modifiers: values, signature, visibility: visibility(values) },
      evidence: node.type,
      kind,
      level: "confirmed",
      name,
      qualifiedName,
      range: syntaxRange(node),
      reason: `Direct Java ${kind} declaration`,
      score: 1,
    });
    declare(state, node, entity);
    index.add({
      arity: parameters(node).length,
      entity,
      language: "java",
      ownerQualifiedName: ownerQualifiedName(state, node),
      packageName: state.packageName,
    });
    addAnnotations(state, node, entity.stableKey, qualifiedName);

    if (node.type === "method_declaration" && isTestMethod(node, state)) {
      const test = makeJvmEntityFact(state.context, {
        attributes: { framework: "junit", testKind: "unit" },
        evidence: node.type,
        kind: "test",
        level: "inferred",
        name,
        qualifiedName: `${qualifiedName}#test`,
        range: syntaxRange(node),
        reason: "Java test annotation or file naming",
        score: 0.9,
      });
      state.entities.set(test.stableKey, test);
      state.testKeys.set(node.id, test.stableKey);
      addRelationship(
        state,
        makeJvmRelationshipFact(state.context, {
          attributes: {},
          evidence: node.type,
          kind: "DECLARES",
          level: "inferred",
          range: syntaxRange(node),
          reason: "Java test annotation or file naming",
          score: 0.9,
          source: entity.stableKey,
          target: test.stableKey,
        }),
      );
    }
  }

  for (const node of namedDescendants(state.tree.rootNode, TYPE_NODES)) {
    const key = state.declarationKeys.get(node.id);
    const name = identifierText(node);
    if (key !== undefined && name !== undefined)
      addAnnotations(state, node, key, typeQualifiedName(state, node, name));
  }
}

function unresolved(
  state: JavaState,
  input: {
    readonly candidates: readonly EntityStableKey[];
    readonly kind: UnresolvedReference["kind"];
    readonly name: string;
    readonly node: SyntaxNode;
    readonly source: EntityStableKey;
  },
): void {
  const range = syntaxRange(input.node);
  state.unresolvedReferences.push({
    artifactPath: state.artifact.path,
    candidateEntityKeys: input.candidates,
    kind: input.kind,
    name: input.name,
    range,
    sourceEntityKey: input.source,
  });
  state.diagnostics.push(
    createDiagnostic({
      artifactPath: state.artifact.path,
      ...(input.candidates.length === 0 ? {} : { candidateEntityKeys: input.candidates }),
      code: input.candidates.length > 1 ? "JAVA_AMBIGUOUS_REFERENCE" : "JAVA_UNRESOLVED_REFERENCE",
      message:
        input.candidates.length > 1
          ? `${input.name} matches ${input.candidates.length} repository symbols`
          : `${input.name} could not be resolved inside the repository`,
      range,
      severity: input.candidates.length > 1 ? "warning" : "information",
    }),
  );
}

function addImports(state: JavaState, index: JvmSymbolIndex): void {
  for (const node of directNamedChildren(state.tree.rootNode, ["import_declaration"])) {
    const binding = importBinding(node);
    if (binding === undefined || binding.wildcard) continue;
    const target = index.all().find(({ entity }) => entity.qualifiedName === binding.qualifiedName);
    if (target === undefined) {
      unresolved(state, {
        candidates: [],
        kind: "import",
        name: binding.qualifiedName,
        node,
        source: state.moduleKey,
      });
      continue;
    }
    addRelationship(
      state,
      makeJvmRelationshipFact(state.context, {
        attributes: { importedName: target.entity.name },
        evidence: node.type,
        kind: "IMPORTS",
        level: "confirmed",
        range: syntaxRange(node),
        reason: "Explicit Java import resolved",
        score: 0.98,
        source: state.moduleKey,
        target: target.entity.stableKey,
      }),
    );
  }
}

function addHeritage(state: JavaState, index: JvmSymbolIndex): void {
  for (const typeNode of namedDescendants(state.tree.rootNode, TYPE_NODES)) {
    const source = state.declarationKeys.get(typeNode.id);
    if (source === undefined) continue;
    for (const clause of directNamedChildren(typeNode, [
      "superclass",
      "super_interfaces",
      "extends_interfaces",
    ])) {
      for (const targetNode of namedDescendants(clause, [
        "type_identifier",
        "scoped_type_identifier",
      ])) {
        const name = targetNode.text;
        const resolution = index.resolveType({
          imports: state.imports,
          name,
          packageName: state.packageName,
        });
        if (resolution.target === undefined) {
          unresolved(state, {
            candidates: resolution.candidateEntityKeys,
            kind: "heritage",
            name,
            node: targetNode,
            source,
          });
          continue;
        }
        addRelationship(
          state,
          makeJvmRelationshipFact(state.context, {
            attributes: {},
            evidence: clause.type,
            kind: clause.type === "super_interfaces" ? "IMPLEMENTS" : "EXTENDS",
            level: "inferred",
            range: syntaxRange(targetNode),
            reason: "Repository-local Java heritage resolved",
            score: 0.9,
            source,
            target: resolution.target.entity.stableKey,
          }),
        );
      }
    }
  }
}

function argumentCount(node: SyntaxNode): number {
  const argumentsNode =
    node.childForFieldName("arguments") ?? firstNamedChild(node, ["argument_list"]);
  return argumentsNode === undefined || argumentsNode === null ? 0 : argumentsNode.namedChildCount;
}

function receiverType(state: JavaState, node: SyntaxNode): string | undefined {
  const receiver = node.childForFieldName("object")?.text;
  if (receiver === undefined) return undefined;
  const field = [...state.entities.values()].find(
    (entity) => entity.kind === "field" && entity.name === receiver,
  );
  return field?.kind === "field" ? field.attributes.type : undefined;
}

function addCalls(state: JavaState, index: JvmSymbolIndex): void {
  for (const node of namedDescendants(state.tree.rootNode, [
    "method_invocation",
    "object_creation_expression",
  ])) {
    const constructor = node.type === "object_creation_expression";
    const name = constructor
      ? node.childForFieldName("type")?.text
      : node.childForFieldName("name")?.text;
    if (name === undefined) continue;
    const source = ownerKey(state, node);
    const argumentList =
      node.childForFieldName("arguments") ?? firstNamedChild(node, ["argument_list"]);
    const firstArgument =
      argumentList === undefined || argumentList === null
        ? undefined
        : argumentList.namedChildren[0];
    if (
      !constructor &&
      /^(?:getProperty|getRequiredProperty)$/u.test(name) &&
      firstArgument !== undefined &&
      firstArgument !== null &&
      firstArgument.type === "string_literal"
    ) {
      state.unresolvedReferences.push({
        artifactPath: state.artifact.path,
        candidateEntityKeys: [],
        kind: "configuration",
        name: firstArgument.text.replace(/^["']|["']$/gu, ""),
        range: syntaxRange(node),
        sourceEntityKey: source,
      });
      continue;
    }
    const ownerName = receiverType(state, node);
    const resolution = constructor
      ? index.resolveConstructor({
          arity: argumentCount(node),
          imports: state.imports,
          name,
          packageName: state.packageName,
        })
      : index.resolveCallable({
          arity: argumentCount(node),
          imports: state.imports,
          name,
          ...(ownerName === undefined ? {} : { ownerName }),
          packageName: state.packageName,
        });
    if (resolution.target === undefined) {
      unresolved(state, {
        candidates: resolution.candidateEntityKeys,
        kind: "call",
        name,
        node,
        source,
      });
      continue;
    }
    const isTest = [...state.entities.values()].some(
      (entity) => entity.stableKey === source && entity.kind === "test",
    );
    addRelationship(
      state,
      makeJvmRelationshipFact(state.context, {
        attributes: isTest ? { basis: "call" } : { resolution: "symbol" },
        evidence: node.type,
        kind: isTest ? "TESTS" : "CALLS",
        level: "inferred",
        range: syntaxRange(node),
        reason: "Unique repository-local Java callable resolved",
        score: 0.9,
        source,
        target: resolution.target.entity.stableKey,
      }),
    );
  }
}

async function createState(
  context: LanguageExtractorContext,
  artifact: SourceArtifactInput,
): Promise<JavaState> {
  const tree = await parseJvmSource("java", artifact.content);
  const factContext: JvmFactContext = {
    artifactPath: artifact.path,
    extractor: "tree-sitter-java",
    language: "java",
    repositoryId: context.repositoryId,
    revisionId: context.revisionId,
  };
  const module = makeJvmEntityFact(factContext, {
    attributes: { path: artifact.path },
    evidence: tree.rootNode.type,
    kind: "module",
    level: "confirmed",
    name: artifact.path,
    qualifiedName: artifact.path,
    range: syntaxRange(tree.rootNode),
    reason: "Java source artifact",
    score: 1,
  });
  const state: JavaState = {
    artifact,
    context: factContext,
    declarationKeys: new Map([[tree.rootNode.id, module.stableKey]]),
    diagnostics: [...syntaxDiagnostics(artifact.path, tree.rootNode, "java")],
    entities: new Map([[module.stableKey, module]]),
    imports: imports(tree.rootNode),
    moduleKey: module.stableKey,
    packageName: packageName(tree.rootNode),
    relationships: [],
    relationshipFingerprints: new Set(),
    testKeys: new Map(),
    tree,
    unresolvedReferences: [],
  };
  if (state.packageName.length > 0) {
    const declaration = firstNamedChild(tree.rootNode, ["package_declaration"]);
    if (declaration !== undefined) {
      const entity = makeJvmEntityFact(factContext, {
        attributes: { packageName: state.packageName },
        evidence: declaration.type,
        kind: "package",
        level: "confirmed",
        name: state.packageName,
        qualifiedName: `${state.packageName}@${artifact.path}`,
        range: syntaxRange(declaration),
        reason: "Direct Java package declaration",
        score: 1,
      });
      declare(state, declaration, entity);
    }
  }
  return state;
}

function toResult(state: JavaState): ArtifactExtractionResult {
  state.tree.delete();
  return Object.freeze({
    artifactPath: state.artifact.path,
    diagnostics: Object.freeze(state.diagnostics),
    entities: Object.freeze([...state.entities.values()]),
    mode: "semantic" as const,
    relationships: Object.freeze(state.relationships),
    unresolvedReferences: Object.freeze(state.unresolvedReferences),
  });
}

export class JavaExtractor implements LanguageExtractor {
  public readonly id = "tree-sitter-java";
  public readonly language = "java" as const;

  public supports(artifact: SourceArtifactInput): boolean {
    return (
      (artifact.artifactKind === "code" || artifact.artifactKind === "test") &&
      artifact.path.endsWith(".java")
    );
  }

  public async extract(
    context: LanguageExtractorContext,
  ): Promise<readonly ArtifactExtractionResult[]> {
    const supported = context.artifacts.filter((artifact) => this.supports(artifact));
    const states = await Promise.all(supported.map((artifact) => createState(context, artifact)));
    const index = new JvmSymbolIndex();
    for (const state of states) addTypes(state, index);
    for (const state of states) addMembers(state, index);
    for (const state of states) {
      addImports(state, index);
      addHeritage(state, index);
      addCalls(state, index);
    }
    return states.map(toResult);
  }
}
