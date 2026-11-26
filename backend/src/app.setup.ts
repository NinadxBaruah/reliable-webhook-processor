import { type INestApplication, ValidationPipe } from '@nestjs/common';

/** HTTP settings shared by main.ts and the e2e tests, so tests exercise the real pipeline. */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );
  app.enableShutdownHooks();
  return app;
}
