import { Kysely, type Migration, type MigrationProvider, Migrator, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import type { Database } from './database.types';
import * as initialSchema from './migrations/0001_initial_schema';

export type DB = Kysely<Database>;

export function createDatabase(connectionString: string, poolMax = 10): DB {
  const pool = new Pool({ connectionString, max: poolMax });
  return new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
}

/**
 * Migrations are registered explicitly instead of read from disk so the compiled output and the
 * ts-jest test run use the same list, with no path tricks.
 */
const migrations: Record<string, Migration> = {
  '0001_initial_schema': initialSchema,
};

class StaticMigrationProvider implements MigrationProvider {
  getMigrations(): Promise<Record<string, Migration>> {
    return Promise.resolve(migrations);
  }
}

/** Applies pending migrations. Kysely holds a lock so concurrent callers are safe. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the migrator works on any schema
export async function migrateToLatest(db: Kysely<any>): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticMigrationProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) {
    throw error instanceof Error ? error : new Error(JSON.stringify(error));
  }
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}
