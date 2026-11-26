import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import type { Env } from '../config/env';

/** Structured JSON logs in production, pretty logs in development. */
export const AppLoggerModule = LoggerModule.forRootAsync({
  inject: [ConfigService],
  useFactory: (config: ConfigService<Env, true>) => {
    const isDev = config.get('NODE_ENV', { infer: true }) === 'development';
    return {
      pinoHttp: {
        level: config.get('LOG_LEVEL', { infer: true }),
        base: { service: process.env.SERVICE_NAME ?? 'webhook-processor' },
        transport: isDev ? { target: 'pino-pretty', options: { singleLine: true } } : undefined,
        // Health checks and the ops page polling would drown out everything else.
        autoLogging: {
          ignore: (req) => req.method === 'GET',
        },
      },
    };
  },
});
