import { randomUUID } from "node:crypto";

import type { Kysely, Selectable } from "kysely";

import type { CatalogDatabase, RepositoryTable } from "./database-types.js";

export interface RegisterRepositoryInput {
  readonly defaultBranch?: string;
  readonly displayName: string;
  readonly id?: string;
  readonly rootPath: string;
  readonly settings?: Readonly<Record<string, unknown>>;
}

export type RepositoryRecord = Selectable<RepositoryTable>;

export class RepositoryCatalog {
  public constructor(private readonly database: Kysely<CatalogDatabase>) {}

  public async register(input: RegisterRepositoryInput): Promise<RepositoryRecord> {
    const id = input.id ?? randomUUID();
    const displayName = input.displayName.trim();
    const rootPath = input.rootPath.trim();

    if (displayName.length === 0 || rootPath.length === 0) {
      throw new Error("Repository display name and root path must not be empty");
    }

    return this.database
      .insertInto("repositories")
      .values({
        default_branch: input.defaultBranch ?? null,
        display_name: displayName,
        id,
        root_path: rootPath,
        settings: { ...(input.settings ?? {}) },
      })
      .onConflict((conflict) =>
        conflict.column("root_path").doUpdateSet({
          default_branch: input.defaultBranch ?? null,
          display_name: displayName,
          settings: { ...(input.settings ?? {}) },
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  public findById(id: string): Promise<RepositoryRecord | undefined> {
    return this.database
      .selectFrom("repositories")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
  }
}
