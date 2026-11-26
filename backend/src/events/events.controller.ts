import { Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ListEventsQuery } from './dto/list-events.query';
import { EventsService } from './events.service';

/** Read side for the operations page, plus manual retry. */
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@Query() query: ListEventsQuery) {
    return this.events.list(query);
  }

  @Get('stats')
  stats() {
    return this.events.stats();
  }

  @Get(':eventId')
  get(@Param('eventId') eventId: string) {
    return this.events.get(eventId);
  }

  @Post(':eventId/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  retry(@Param('eventId') eventId: string) {
    return this.events.retry(eventId);
  }
}
