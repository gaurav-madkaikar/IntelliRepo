import type { EntityStableKey } from "./identity.js";
import type { FactProvenance } from "./provenance.js";

export const RELATIONSHIP_KINDS = [
  "CONTAINS",
  "DECLARES",
  "IMPORTS",
  "EXTENDS",
  "IMPLEMENTS",
  "CALLS",
  "HANDLES",
  "USES_MIDDLEWARE",
  "READS_CONFIG",
  "TESTS",
  "DOCUMENTS",
  "DEPENDS_ON",
] as const;

export type RelationshipKind = (typeof RELATIONSHIP_KINDS)[number];

type NoRelationshipAttributes = Readonly<Record<string, never>>;

export interface RelationshipAttributesByKind {
  readonly CALLS: {
    readonly resolution: "name" | "symbol" | "unresolved";
  };
  readonly CONTAINS: NoRelationshipAttributes;
  readonly DECLARES: NoRelationshipAttributes;
  readonly DEPENDS_ON: {
    readonly scope?: string;
  };
  readonly DOCUMENTS: {
    readonly sectionHeading?: string;
  };
  readonly EXTENDS: NoRelationshipAttributes;
  readonly HANDLES: {
    readonly httpMethod: string;
    readonly path: string;
  };
  readonly IMPLEMENTS: NoRelationshipAttributes;
  readonly IMPORTS: {
    readonly importedName?: string;
  };
  readonly READS_CONFIG: {
    readonly access: "binding" | "direct";
  };
  readonly TESTS: {
    readonly basis: "call" | "framework" | "import" | "naming";
  };
  readonly USES_MIDDLEWARE: {
    readonly order?: number;
  };
}

interface RelationshipFactBase<K extends RelationshipKind> {
  readonly attributes: Readonly<RelationshipAttributesByKind[K]>;
  readonly kind: K;
  readonly provenance: FactProvenance;
  readonly source: EntityStableKey;
  readonly target: EntityStableKey;
}

export type RelationshipFact = {
  readonly [K in RelationshipKind]: Readonly<RelationshipFactBase<K>>;
}[RelationshipKind];
