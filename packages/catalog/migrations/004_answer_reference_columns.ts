import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE answer_references
      RENAME COLUMN line_end TO end_line
  `.execute(database);
}

export async function down(database: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE answer_references
      RENAME COLUMN end_line TO line_end
  `.execute(database);
}
