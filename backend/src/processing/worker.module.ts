import {
  type BeforeApplicationShutdown,
  Module,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { AppLoggerModule } from '../common/logger.module';
import { AppConfigModule } from '../config/config.module';
import { parseEnv } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { EventProcessor } from './event-processor';
import { EventQueue } from './event-queue';
import { WorkerRunner } from './worker-runner';
import { WORKER_SETTINGS, workerSettingsFromEnv } from './worker-settings';

/** The worker application: no HTTP server, only the processing loop. */
@Module({
  imports: [AppConfigModule, AppLoggerModule, DatabaseModule],
  providers: [
    {
      provide: WORKER_SETTINGS,
      // Same validated env the ConfigModule already checked at startup.
      useFactory: () => workerSettingsFromEnv(parseEnv()),
    },
    EventQueue,
    EventProcessor,
    WorkerRunner,
  ],
})
export class WorkerModule implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(private readonly runner: WorkerRunner) {}

  onApplicationBootstrap(): void {
    this.runner.start();
  }

  /** SIGTERM (docker stop): finish or hand back in-flight work before the DB pool closes. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.runner.stop();
  }
}
