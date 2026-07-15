import type { EntityFact, EntityStableKey, SourceLanguage } from "@intellirepo/domain";

export interface ImportBinding {
  readonly alias?: string;
  readonly isStatic: boolean;
  readonly qualifiedName: string;
  readonly wildcard: boolean;
}

export interface SymbolRecord {
  readonly arity?: number;
  readonly entity: EntityFact;
  readonly language: Extract<SourceLanguage, "java" | "kotlin">;
  readonly ownerQualifiedName?: string;
  readonly packageName: string;
}

export interface ResolutionRequest {
  readonly arity?: number;
  readonly imports: readonly ImportBinding[];
  readonly name: string;
  readonly ownerName?: string;
  readonly packageName: string;
}

export interface SymbolResolution {
  readonly candidateEntityKeys: readonly EntityStableKey[];
  readonly target?: SymbolRecord;
}

const CALLABLE_KINDS = new Set(["class", "constructor", "function", "method"]);
const TYPE_KINDS = new Set(["class", "interface", "object"]);

function simpleName(qualifiedName: string): string {
  return qualifiedName.split(/[.#]/u).at(-1) ?? qualifiedName;
}

export class JvmSymbolIndex {
  private readonly symbols: SymbolRecord[] = [];

  public add(record: SymbolRecord): void {
    this.symbols.push(record);
  }

  public all(): readonly SymbolRecord[] {
    return this.symbols;
  }

  public resolveType(request: ResolutionRequest): SymbolResolution {
    return this.resolve(request, TYPE_KINDS);
  }

  public resolveCallable(request: ResolutionRequest): SymbolResolution {
    return this.resolve(request, CALLABLE_KINDS);
  }

  public resolveConstructor(request: ResolutionRequest): SymbolResolution {
    return this.resolve(request, new Set(["constructor"]));
  }

  private resolve(request: ResolutionRequest, allowedKinds: ReadonlySet<string>): SymbolResolution {
    const aliasImport = request.imports.find(({ alias }) => alias === request.name);
    const explicitNames = request.imports
      .filter(({ wildcard }) => !wildcard)
      .filter(
        ({ qualifiedName, alias }) =>
          alias === request.name || simpleName(qualifiedName) === request.name,
      )
      .map(({ qualifiedName }) => qualifiedName);
    const wildcardPackages = request.imports
      .filter(({ wildcard }) => wildcard)
      .map(({ qualifiedName }) => qualifiedName);

    const candidates = this.symbols.filter(({ arity, entity, ownerQualifiedName, packageName }) => {
      if (!allowedKinds.has(entity.kind)) return false;
      if (request.arity !== undefined && arity !== undefined && arity !== request.arity)
        return false;
      if (
        request.ownerName !== undefined &&
        ownerQualifiedName !== request.ownerName &&
        simpleName(ownerQualifiedName ?? "") !== simpleName(request.ownerName)
      )
        return false;
      const qualifiedName = entity.qualifiedName ?? "";
      const nameMatches = entity.name === request.name || qualifiedName === request.name;
      const aliasMatches = aliasImport !== undefined && qualifiedName === aliasImport.qualifiedName;
      if (!nameMatches && !aliasMatches) return false;
      return (
        qualifiedName === request.name ||
        explicitNames.includes(qualifiedName) ||
        packageName === request.packageName ||
        wildcardPackages.includes(packageName) ||
        aliasMatches
      );
    });

    const distinct = [
      ...new Map(candidates.map((candidate) => [candidate.entity.stableKey, candidate])).values(),
    ];
    return {
      candidateEntityKeys: distinct.map(({ entity }) => entity.stableKey),
      ...(distinct.length === 1 && distinct[0] !== undefined ? { target: distinct[0] } : {}),
    };
  }
}
