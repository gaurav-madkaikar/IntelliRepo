import { createHash } from "node:crypto";

import type { EntityKind, SourceLanguage } from "./entities.js";

declare const entityStableKeyBrand: unique symbol;

export type EntityStableKey = string & { readonly [entityStableKeyBrand]: true };

export interface EntityIdentityInput {
  readonly kind: EntityKind;
  readonly language?: SourceLanguage;
  readonly qualifiedName?: string;
  readonly repositoryId: string;
  readonly syntaxPath?: string;
}

function normalizePart(value: string): string {
  return value.normalize("NFC").trim().replaceAll("\\", "/");
}

function requiredPart(name: string, value: string): string {
  const normalized = normalizePart(value);

  if (normalized.length === 0) {
    throw new Error(`${name} must not be empty`);
  }

  return normalized;
}

export function createEntityStableKey(input: EntityIdentityInput): EntityStableKey {
  const repositoryId = requiredPart("repositoryId", input.repositoryId);
  const qualifiedName = input.qualifiedName?.trim();
  const syntaxPath = input.syntaxPath?.trim();

  if (
    (qualifiedName === undefined || qualifiedName.length === 0) &&
    (syntaxPath === undefined || syntaxPath.length === 0)
  ) {
    throw new Error("Entity identity requires a qualifiedName or syntaxPath");
  }

  const localIdentity =
    qualifiedName !== undefined && qualifiedName.length > 0
      ? `name:${requiredPart("qualifiedName", qualifiedName)}`
      : `syntax:${requiredPart("syntaxPath", syntaxPath ?? "")}`;
  const canonicalIdentity = [
    repositoryId,
    input.language ?? "language-neutral",
    input.kind,
    localIdentity,
  ].join("\u001f");
  const digest = createHash("sha256").update(canonicalIdentity).digest("hex").slice(0, 24);

  return `${repositoryId}:${input.kind}:${digest}` as EntityStableKey;
}
