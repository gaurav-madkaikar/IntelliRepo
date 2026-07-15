import { promises as fileSystem } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Kysely, PostgresDialect } from "kysely";
import { FileMigrationProvider, Migrator, type MigrationResultSet } from "kysely/migration";
import { Pool } from "pg";

import type { CatalogDatabase } from "./database-types.js";

export interface CatalogDatabaseHandle {
  readonly database: Kysely<CatalogDatabase>;
  destroy(): Promise<void>;
}

export function createCatalogDatabase(connectionString: string): CatalogDatabaseHandle {
  const pool = new Pool({ connectionString, max: 10 });
  const database = new Kysely<CatalogDatabase>({ dialect: new PostgresDialect({ pool }) });

  return {
    database,
    destroy: async () => {
      await database.destroy();
    },
  };
}

function createMigrator(database: Kysely<CatalogDatabase>, migrationFolder?: string): Migrator {
  return new Migrator({
    db: database,
    provider: new FileMigrationProvider({
      fs: fileSystem,
      migrationFolder: migrationFolder ?? fileURLToPath(new URL("../migrations", import.meta.url)),
      path,
    }),
  });
}

export async function migrateCatalogToLatest(
  database: Kysely<CatalogDatabase>,
  migrationFolder?: string,
): Promise<MigrationResultSet> {
  return createMigrator(database, migrationFolder).migrateToLatest();
}

export async function migrateCatalogDown(
  database: Kysely<CatalogDatabase>,
  migrationFolder?: string,
): Promise<MigrationResultSet> {
  return createMigrator(database, migrationFolder).migrateDown();
}
