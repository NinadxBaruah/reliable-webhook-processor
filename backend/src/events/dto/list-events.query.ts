import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import type { EventStatus } from '../../database/database.types';

export const EVENT_STATUSES: EventStatus[] = ['pending', 'processing', 'succeeded', 'failed'];

export class ListEventsQuery {
  @IsOptional()
  @IsIn(EVENT_STATUSES)
  status?: EventStatus;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit = 100;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}
