import { Logger } from '@nestjs/common';

// Worker logs are noise in test output; failures are reported through assertions.
Logger.overrideLogger(false);
