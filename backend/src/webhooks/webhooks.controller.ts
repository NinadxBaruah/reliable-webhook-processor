import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { type IngestResult, WebhookEventDto } from './dto/webhook-event.dto';
import { WebhooksService } from './webhooks.service';

@Controller('webhooks')
export class WebhooksController {
  constructor(private readonly webhooks: WebhooksService) {}

  /**
   * Returns 202 only after the event is committed to PostgreSQL, for new and duplicate
   * deliveries alike. Processing happens later in the workers.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  receive(@Body() event: WebhookEventDto): Promise<IngestResult> {
    return this.webhooks.ingest(event);
  }
}
