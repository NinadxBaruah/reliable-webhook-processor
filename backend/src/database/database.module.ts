import { Global, Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env';
import { createDatabase, type DB } from './database';

export const KYSELY = Symbol('KYSELY');

/** Injects the shared Kysely instance. */
export const InjectDb = () => Inject(KYSELY);

@Injectable()
class DatabaseLifecycle implements OnApplicationShutdown {
  constructor(@InjectDb() private readonly db: DB) {}

  async onApplicationShutdown(): Promise<void> {
    await this.db.destroy();
  }
}

@Global()
@Module({
  providers: [
    {
      provide: KYSELY,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): DB =>
        createDatabase(
          config.get('DATABASE_URL', { infer: true }),
          config.get('DB_POOL_MAX', { infer: true }),
        ),
    },
    DatabaseLifecycle,
  ],
  exports: [KYSELY],
})
export class DatabaseModule {}
