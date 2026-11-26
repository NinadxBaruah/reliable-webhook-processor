import { TEST_DATABASE_URL } from './helpers';

// Must be imported before AppModule: ConfigModule validates process.env when the module loads.
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
