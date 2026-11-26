import { ConfigModule } from '@nestjs/config';
import { parseEnv } from './env';

/** Global, validated configuration shared by the API and worker applications. */
export const AppConfigModule = ConfigModule.forRoot({
  isGlobal: true,
  cache: true,
  ignoreEnvFile: true,
  validate: (raw) => parseEnv(raw as Record<string, string | undefined>),
});
