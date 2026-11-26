import { Module } from '@nestjs/common';
import { AppLoggerModule } from './common/logger.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { EventsModule } from './events/events.module';
import { HealthController } from './health/health.controller';
import { WebhooksModule } from './webhooks/webhooks.module';

/** The HTTP API: receives webhooks and serves the operations page. It never processes events. */
@Module({
  imports: [AppConfigModule, AppLoggerModule, DatabaseModule, WebhooksModule, EventsModule],
  controllers: [HealthController],
})
export class AppModule {}
