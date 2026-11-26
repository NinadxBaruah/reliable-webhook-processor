import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { sql } from 'kysely';
import type { DB } from '../database/database';
import { InjectDb } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(@InjectDb() private readonly db: DB) {}

  @Get()
  async check(): Promise<{ status: 'ok' }> {
    try {
      await sql`select 1`.execute(this.db);
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
  }
}
