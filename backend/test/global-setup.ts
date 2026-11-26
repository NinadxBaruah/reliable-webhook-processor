import { prepareTestDatabase } from './support/helpers';

/** Creates and migrates the test database once, before any test file runs. */
export default async function globalSetup(): Promise<void> {
  await prepareTestDatabase();
}
