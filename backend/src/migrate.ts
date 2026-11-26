import { parseEnv } from './config/env';
import { createDatabase, migrateToLatest } from './database/database';

/** One-shot entrypoint: brings the schema up to date, then exits. Run before the API and workers. */
async function main(): Promise<void> {
  const env = parseEnv();
  const db = createDatabase(env.DATABASE_URL, 1);
  try {
    const applied = await migrateToLatest(db);
    console.log(
      applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Schema already up to date',
    );
  } finally {
    await db.destroy();
  }
}

main().catch((err: unknown) => {
  console.error('Migration failed', err);
  process.exit(1);
});
