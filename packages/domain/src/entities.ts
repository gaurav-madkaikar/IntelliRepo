import type { EntityStableKey } from "./identity.js";
import type { FactProvenance } from "./provenance.js";

export const SOURCE_LANGUAGES = ["java", "kotlin", "typescript", "unknown"] as const;

export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];

export const ENTITY_KINDS = [
  "repository",
  "module",
  "package",
  "file",
  "class",
  "interface",
  "object",
  "function",
  "method",
  "endpoint",
  "middleware",
  "test",
  "configuration_key",
  "environment_variable",
  "dependency",
  "build_script",
  "documentation_page",
  "documentation_section",
] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface SymbolAttributes {
  readonly modifiers?: readonly string[];
  readonly signature?: string;
  readonly visibility?: "internal" | "package" | "private" | "protected" | "public";
}

export interface EntityAttributesByKind {
  readonly build_script: {
    readonly buildTool: "gradle" | "maven" | "npm" | "pnpm" | "unknown";
    readonly commands: readonly string[];
  };
  readonly class: SymbolAttributes & {
    readonly declarationKind?: "class" | "enum" | "record";
  };
  readonly configuration_key: {
    readonly defaultValue?: string;
    readonly key: string;
  };
  readonly dependency: {
    readonly coordinate: string;
    readonly scope?: string;
  };
  readonly documentation_page: {
    readonly path: string;
    readonly title?: string;
  };
  readonly documentation_section: {
    readonly heading: string;
    readonly level: number;
  };
  readonly endpoint: {
    readonly declaredPath: string;
    readonly handlerEntityKey: EntityStableKey;
    readonly httpMethod: string;
    readonly normalizedPath: string;
    readonly requestType?: string;
    readonly responseType?: string;
  };
  readonly environment_variable: {
    readonly name: string;
  };
  readonly file: {
    readonly artifactKind: "build" | "code" | "configuration" | "documentation" | "test";
    readonly path: string;
  };
  readonly function: SymbolAttributes;
  readonly interface: SymbolAttributes;
  readonly method: SymbolAttributes;
  readonly middleware: SymbolAttributes;
  readonly module: {
    readonly path?: string;
  };
  readonly object: SymbolAttributes;
  readonly package: {
    readonly packageName: string;
  };
  readonly repository: {
    readonly rootPath: string;
  };
  readonly test: SymbolAttributes & {
    readonly framework?: string;
    readonly testKind?: "integration" | "unit" | "unknown";
  };
}

interface EntityFactBase<K extends EntityKind> {
  readonly attributes: Readonly<EntityAttributesByKind[K]>;
  readonly kind: K;
  readonly language?: SourceLanguage;
  readonly name: string;
  readonly provenance: FactProvenance;
  readonly qualifiedName?: string;
  readonly stableKey: EntityStableKey;
}

export type EntityFact = {
  readonly [K in EntityKind]: Readonly<EntityFactBase<K>>;
}[EntityKind];
