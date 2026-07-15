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
  namedDescendants,
  syntaxDiagnostics,
  syntaxRange,
} from "../jvm/syntax.js";
import { parseJvmSource } from "../jvm/tree-sitter-runtime.js";

const TYPE_NODES = ["class_declaration", "object_declaration", "companion_object"] as const;

interface KotlinState {
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
  const header = firstNamedChild(root, ["package_header"]);
  return header?.text.replace(/^package\s+/u, "").trim() ?? "";
}

function importBinding(node: SyntaxNode): ImportBinding | undefined {
  const match = /^import\s+([^\s]+)(?:\s+as\s+([^\s]+))?$/u.exec(node.text.trim());
  if (match?.[1] === undefined) return undefined;
  const raw = match[1];
  return {
    ...(match[2] === undefined ? {} : { alias: match[2] }),
    isStatic: false,
    qualifiedName: raw.replace(/\.\*$/u, ""),
    wildcard: raw.endsWith(".*"),
  };
}

function imports(root: SyntaxNode): readonly ImportBinding[] {
  return namedDescendants(root, "import_header").flatMap((node) => {
    const binding = importBinding(node);
    return binding === undefined ? [] : [binding];
  });
}

function typeName(node: SyntaxNode): string | undefined {
  if (node.type === "companion_object") {
    return firstNamedChild(node, ["type_identifier", "simple_identifier"])?.text ?? "Companion";
  }
  return firstNamedChild(node, ["type_identifier", "simple_identifier"])?.text;
}

function enclosingTypes(node: SyntaxNode): readonly SyntaxNode[] {
  const result: SyntaxNode[] = [];
  let parent = node.parent;
  while (parent !== null) {
    if ((TYPE_NODES as readonly string[]).includes(parent.type)) result.unshift(parent);
    parent = parent.parent;
  }
  return result;
}

function typeQualifiedName(state: KotlinState, node: SyntaxNode, name: string): string {
  const parents = enclosingTypes(node)
    .map(typeName)
    .filter((value): value is string => value !== undefined);
  return [...(state.packageName.length === 0 ? [] : [state.packageName]), ...parents, name].join(
    ".",
  );
}

function ownerQualifiedName(state: KotlinState, node: SyntaxNode): string {
  const owner = enclosingTypes(node).at(-1);
  if (owner === undefined)
    return state.packageName.length === 0 ? state.artifact.path : state.packageName;
  const name = typeName(owner) ?? "anonymous";
  return typeQualifiedName(state, owner, name);
}

function modifiers(node: SyntaxNode): readonly string[] {
  const modifierNode = firstNamedChild(node, ["modifiers"]);
  if (modifierNode === undefined) return [];
  return modifierNode.namedChildren
    .filter((child): child is SyntaxNode => child !== null && child.type !== "annotation")
    .map(({ text }) => text.trim())
    .filter((value) => value.length > 0);
}

function visibility(values: readonly string[]) {
  if (values.includes("private")) return "private" as const;
  if (values.includes("protected")) return "protected" as const;
  if (values.includes("internal")) return "internal" as const;
  return "public" as const;
}

function functionParameters(node: SyntaxNode): readonly SyntaxNode[] {
  const list = firstNamedChild(node, ["function_value_parameters"]);
  return list === undefined ? [] : directNamedChildren(list, ["parameter"]);
}

function parameterType(node: SyntaxNode): string {
  return (
    firstNamedChild(node, ["user_type", "nullable_type", "function_type"])?.text.replace(
      /\s+/gu,
      "",
    ) ?? "?"
  );
}

function extensionReceiver(node: SyntaxNode): string | undefined {
  const name = firstNamedChild(node, ["simple_identifier"]);
  const receiver = node.namedChildren.find(
    (child): child is SyntaxNode =>
      child !== null &&
      (child.type === "user_type" || child.type === "nullable_type") &&
      name !== undefined &&
      child.endIndex <= name.startIndex,
  );
  return receiver?.text;
}

function functionQualifiedName(state: KotlinState, node: SyntaxNode, name: string): string {
  const signature = functionParameters(node).map(parameterType).join(",");
  const receiver = extensionReceiver(node);
  return `${ownerQualifiedName(state, node)}.${receiver === undefined ? "" : `${receiver}.`}${name}(${signature})`;
}

function declarationOwnerKey(state: KotlinState, node: SyntaxNode): EntityStableKey {
  let current = node.parent;
  while (current !== null) {
    const key = state.declarationKeys.get(current.id);
    if (key !== undefined) return key;
    current = current.parent;
  }
  return state.moduleKey;
}

function ownerKey(state: KotlinState, node: SyntaxNode): EntityStableKey {
  let current: SyntaxNode | null = node;
  while (current !== null) {
    const test = state.testKeys.get(current.id);
    if (test !== undefined) return test;
    const key = state.declarationKeys.get(current.id);
    if (key !== undefined) return key;
    current = current.parent;
  }
  return state.moduleKey;
}

function addRelationship(state: KotlinState, relationship: RelationshipFact): void {
  const fingerprint = `${relationship.kind}:${relationship.source}:${relationship.target}:${relationship.provenance.range.start.line}:${relationship.provenance.range.start.column}`;
  if (!state.relationshipFingerprints.has(fingerprint)) {
    state.relationshipFingerprints.add(fingerprint);
    state.relationships.push(relationship);
  }
}

function declare(state: KotlinState, node: SyntaxNode, entity: EntityFact): void {
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
      reason: "Direct Kotlin declaration",
      score: 1,
      source: declarationOwnerKey(state, node),
      target: entity.stableKey,
    }),
  );
}

function isInterface(node: SyntaxNode): boolean {
  return /(?:^|\s)interface\s+/u.test(node.text.slice(0, Math.min(node.text.length, 80)));
}

function addTypes(state: KotlinState, index: JvmSymbolIndex): void {
  for (const node of namedDescendants(state.tree.rootNode, TYPE_NODES)) {
    const name = typeName(node);
    if (name === undefined) continue;
    const values = modifiers(node);
    const common = {
      evidence: node.type,
      level: "confirmed" as const,
      name,
      qualifiedName: typeQualifiedName(state, node, name),
      range: syntaxRange(node),
      reason: "Direct Kotlin type declaration",
      score: 1,
    };
    const entity = isInterface(node)
      ? makeJvmEntityFact(state.context, {
          ...common,
          attributes: { modifiers: values, visibility: visibility(values) },
          kind: "interface",
        })
      : node.type === "object_declaration" || node.type === "companion_object"
        ? makeJvmEntityFact(state.context, {
            ...common,
            attributes: { modifiers: values, visibility: visibility(values) },
            kind: "object",
          })
        : makeJvmEntityFact(state.context, {
            ...common,
            attributes: {
              declarationKind: "class",
              modifiers: values,
              visibility: visibility(values),
            },
            kind: "class",
          });
    declare(state, node, entity);
    index.add({ entity, language: "kotlin", packageName: state.packageName });

    const constructor = firstNamedChild(node, ["primary_constructor"]);
    if (constructor !== undefined) {
      const params = directNamedChildren(constructor, ["class_parameter"]);
      const constructorEntity = makeJvmEntityFact(state.context, {
        attributes: {
          signature: `${name}(${params.map(parameterType).join(",")})`,
          visibility: visibility(modifiers(constructor)),
        },
        evidence: constructor.type,
        kind: "constructor",
        level: "confirmed",
        name,
        qualifiedName: `${common.qualifiedName}.${name}(${params.map(parameterType).join(",")})`,
        range: syntaxRange(constructor),
        reason: "Direct Kotlin primary constructor",
        score: 1,
      });
      declare(state, constructor, constructorEntity);
      index.add({
        arity: params.length,
        entity: constructorEntity,
        language: "kotlin",
        ownerQualifiedName: common.qualifiedName,
        packageName: state.packageName,
      });
      for (const parameter of params) {
        if (firstNamedChild(parameter, ["binding_pattern_kind"]) === undefined) continue;
        const parameterName = firstNamedChild(parameter, ["simple_identifier"])?.text;
        if (parameterName === undefined) continue;
        const type = firstNamedChild(parameter, ["user_type", "nullable_type"])?.text;
        const field = makeJvmEntityFact(state.context, {
          attributes: {
            ...(type === undefined ? {} : { type }),
            visibility: visibility(modifiers(parameter)),
          },
          evidence: parameter.type,
          kind: "field",
          level: "confirmed",
          name: parameterName,
          qualifiedName: `${common.qualifiedName}.${parameterName}`,
          range: syntaxRange(parameter),
          reason: "Kotlin constructor property",
          score: 1,
        });
        declare(state, parameter, field);
      }
    }
  }
}

function annotations(node: SyntaxNode): readonly SyntaxNode[] {
  const modifierNode = firstNamedChild(node, ["modifiers"]);
  return modifierNode === undefined ? [] : namedDescendants(modifierNode, "annotation");
}

function annotationName(node: SyntaxNode): string {
  return (
    firstNamedChild(node, ["user_type", "type_identifier"])?.text ??
    node.text.replace(/^@/u, "").split("(")[0]?.trim() ??
    node.text
  );
}

function addAnnotations(
  state: KotlinState,
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
      reason: "Direct Kotlin annotation",
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
        reason: "Direct Kotlin annotation",
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

function isTestFunction(state: KotlinState, node: SyntaxNode): boolean {
  return (
    annotations(node).some((annotation) => /(?:^|\.)Test$/u.test(annotationName(annotation))) ||
    /(?:Test|Spec)\.kt$/u.test(state.artifact.path)
  );
}

function addFields(state: KotlinState): void {
  for (const node of namedDescendants(state.tree.rootNode, "property_declaration")) {
    const declaration = firstNamedChild(node, ["variable_declaration"]);
    const name =
      declaration === undefined
        ? undefined
        : firstNamedChild(declaration, ["simple_identifier"])?.text;
    if (declaration === undefined || name === undefined) continue;
    const values = modifiers(node);
    const type = firstNamedChild(declaration, ["user_type", "nullable_type"])?.text;
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
      range: syntaxRange(declaration),
      reason: "Direct Kotlin property declaration",
      score: 1,
    });
    declare(state, declaration, entity);
  }
}

function addFunctions(state: KotlinState, index: JvmSymbolIndex): void {
  for (const node of namedDescendants(state.tree.rootNode, "function_declaration")) {
    const name = firstNamedChild(node, ["simple_identifier"])?.text;
    if (name === undefined) continue;
    const values = modifiers(node);
    const qualifiedName = functionQualifiedName(state, node, name);
    const params = functionParameters(node);
    const entity = makeJvmEntityFact(state.context, {
      attributes: {
        modifiers: values,
        signature: `${extensionReceiver(node) === undefined ? "" : `${extensionReceiver(node)}.`}${name}(${params.map(parameterType).join(",")})`,
        visibility: visibility(values),
      },
      evidence: node.type,
      kind: enclosingTypes(node).length === 0 ? "function" : "method",
      level: "confirmed",
      name,
      qualifiedName,
      range: syntaxRange(node),
      reason: "Direct Kotlin function declaration",
      score: 1,
    });
    declare(state, node, entity);
    index.add({
      arity: params.length,
      entity,
      language: "kotlin",
      ownerQualifiedName: ownerQualifiedName(state, node),
      packageName: state.packageName,
    });
    addAnnotations(state, node, entity.stableKey, qualifiedName);
    if (isTestFunction(state, node)) {
      const test = makeJvmEntityFact(state.context, {
        attributes: { framework: "kotlin-test", testKind: "unit" },
        evidence: node.type,
        kind: "test",
        level: "inferred",
        name,
        qualifiedName: `${qualifiedName}#test`,
        range: syntaxRange(node),
        reason: "Kotlin test annotation or file naming",
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
          reason: "Kotlin test annotation or file naming",
          score: 0.9,
          source: entity.stableKey,
          target: test.stableKey,
        }),
      );
    }
  }

  for (const node of namedDescendants(state.tree.rootNode, TYPE_NODES)) {
    const key = state.declarationKeys.get(node.id);
    const name = typeName(node);
    if (key !== undefined && name !== undefined)
      addAnnotations(state, node, key, typeQualifiedName(state, node, name));
  }
}

function unresolved(
  state: KotlinState,
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
      code:
        input.candidates.length > 1 ? "KOTLIN_AMBIGUOUS_REFERENCE" : "KOTLIN_UNRESOLVED_REFERENCE",
      message:
        input.candidates.length > 1
          ? `${input.name} matches ${input.candidates.length} repository symbols`
          : `${input.name} could not be resolved inside the repository`,
      range,
      severity: input.candidates.length > 1 ? "warning" : "information",
    }),
  );
}

function addImports(state: KotlinState, index: JvmSymbolIndex): void {
  for (const node of namedDescendants(state.tree.rootNode, "import_header")) {
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
        attributes: { importedName: binding.alias ?? target.entity.name },
        evidence: node.type,
        kind: "IMPORTS",
        level: "confirmed",
        range: syntaxRange(node),
        reason: "Explicit Kotlin import resolved",
        score: 0.98,
        source: state.moduleKey,
        target: target.entity.stableKey,
      }),
    );
  }
}

function addHeritage(state: KotlinState, index: JvmSymbolIndex): void {
  for (const typeNode of namedDescendants(state.tree.rootNode, "class_declaration")) {
    const source = state.declarationKeys.get(typeNode.id);
    if (source === undefined) continue;
    const clauses = directNamedChildren(typeNode, ["delegation_specifier"]);
    for (const clause of clauses) {
      const targetNode = firstNamedChild(clause, ["constructor_invocation", "user_type"]);
      const userType =
        targetNode?.type === "constructor_invocation"
          ? firstNamedChild(targetNode, ["user_type"])
          : targetNode;
      const name = userType?.text;
      if (userType === undefined || name === undefined) continue;
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
          node: userType,
          source,
        });
        continue;
      }
      addRelationship(
        state,
        makeJvmRelationshipFact(state.context, {
          attributes: {},
          evidence: clause.type,
          kind:
            targetNode?.type === "constructor_invocation"
              ? "EXTENDS"
              : isInterface(typeNode)
                ? "EXTENDS"
                : "IMPLEMENTS",
          level: "inferred",
          range: syntaxRange(userType),
          reason: "Repository-local Kotlin heritage resolved",
          score: 0.9,
          source,
          target: resolution.target.entity.stableKey,
        }),
      );
    }
  }
}

function callName(node: SyntaxNode): string | undefined {
  const navigation = firstNamedChild(node, ["navigation_expression"]);
  if (navigation !== undefined) {
    return namedDescendants(navigation, "simple_identifier").at(-1)?.text;
  }
  return firstNamedChild(node, ["simple_identifier"])?.text;
}

function callReceiver(node: SyntaxNode): string | undefined {
  const navigation = firstNamedChild(node, ["navigation_expression"]);
  return navigation === undefined
    ? undefined
    : firstNamedChild(navigation, ["simple_identifier"])?.text;
}

function callArity(node: SyntaxNode): number {
  const suffix = firstNamedChild(node, ["call_suffix"]);
  const argumentsNode =
    suffix === undefined ? undefined : firstNamedChild(suffix, ["value_arguments"]);
  return argumentsNode === undefined
    ? 0
    : directNamedChildren(argumentsNode, ["value_argument"]).length;
}

function receiverType(state: KotlinState, node: SyntaxNode): string | undefined {
  const receiver = callReceiver(node);
  if (receiver === undefined) return undefined;
  const field = [...state.entities.values()].find(
    (entity) => entity.kind === "field" && entity.name === receiver,
  );
  return field?.kind === "field" ? field.attributes.type : undefined;
}

function addCalls(state: KotlinState, index: JvmSymbolIndex): void {
  for (const node of namedDescendants(state.tree.rootNode, "call_expression")) {
    const name = callName(node);
    if (name === undefined) continue;
    const source = ownerKey(state, node);
    const suffix = firstNamedChild(node, ["call_suffix"]);
    const values = suffix === undefined ? undefined : firstNamedChild(suffix, ["value_arguments"]);
    const firstValue =
      values === undefined ? undefined : firstNamedChild(values, ["value_argument"]);
    const stringValue =
      firstValue === undefined ? undefined : firstNamedChild(firstValue, ["string_literal"]);
    if (/^(?:getProperty|getRequiredProperty|property)$/u.test(name) && stringValue !== undefined) {
      const content = firstNamedChild(stringValue, ["string_content"])?.text;
      if (content !== undefined) {
        state.unresolvedReferences.push({
          artifactPath: state.artifact.path,
          candidateEntityKeys: [],
          kind: "configuration",
          name: content,
          range: syntaxRange(node),
          sourceEntityKey: source,
        });
        continue;
      }
    }
    const ownerName = receiverType(state, node);
    const resolution = index.resolveCallable({
      arity: callArity(node),
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
        reason: "Unique repository-local Kotlin callable resolved",
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
): Promise<KotlinState> {
  const tree = await parseJvmSource("kotlin", artifact.content);
  const factContext: JvmFactContext = {
    artifactPath: artifact.path,
    extractor: "tree-sitter-kotlin",
    language: "kotlin",
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
    reason: "Kotlin source artifact",
    score: 1,
  });
  const state: KotlinState = {
    artifact,
    context: factContext,
    declarationKeys: new Map([[tree.rootNode.id, module.stableKey]]),
    diagnostics: [...syntaxDiagnostics(artifact.path, tree.rootNode, "kotlin")],
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
    const header = firstNamedChild(tree.rootNode, ["package_header"]);
    if (header !== undefined) {
      const entity = makeJvmEntityFact(factContext, {
        attributes: { packageName: state.packageName },
        evidence: header.type,
        kind: "package",
        level: "confirmed",
        name: state.packageName,
        qualifiedName: `${state.packageName}@${artifact.path}`,
        range: syntaxRange(header),
        reason: "Direct Kotlin package declaration",
        score: 1,
      });
      declare(state, header, entity);
    }
  }
  return state;
}

function toResult(state: KotlinState): ArtifactExtractionResult {
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

export class KotlinExtractor implements LanguageExtractor {
  public readonly id = "tree-sitter-kotlin";
  public readonly language = "kotlin" as const;

  public supports(artifact: SourceArtifactInput): boolean {
    return (
      (artifact.artifactKind === "code" || artifact.artifactKind === "test") &&
      (artifact.path.endsWith(".kt") || artifact.path.endsWith(".kts"))
    );
  }

  public async extract(
    context: LanguageExtractorContext,
  ): Promise<readonly ArtifactExtractionResult[]> {
    const supported = context.artifacts.filter((artifact) => this.supports(artifact));
    const states = await Promise.all(supported.map((artifact) => createState(context, artifact)));
    const index = new JvmSymbolIndex();
    for (const state of states) addTypes(state, index);
    for (const state of states) {
      addFields(state);
      addFunctions(state, index);
    }
    for (const state of states) {
      addImports(state, index);
      addHeritage(state, index);
      addCalls(state, index);
    }
    return states.map(toResult);
  }
}
