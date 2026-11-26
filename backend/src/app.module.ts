import { Module } from '@nestjs/common';
import { AppLoggerModule } from './common/logger.module';
import { AppConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { HealthController } from './health/health.controller';
import { WebhooksModule } from './webhooks/webhooks.module';

/** The HTTP API: receives webhooks. It never processes events itself. */
@Module({
  imports: [AppConfigModule, AppLoggerModule, DatabaseModule, WebhooksModule],
  controllers: [HealthController],
})
export class AppModule {}
