import { IsNotEmpty, IsObject, IsString, MaxLength } from 'class-validator';

export class WebhookEventDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  eventId: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  type: string;

  /** Free-form event data. Fields the processor needs (orderId, simulate) are checked when processing. */
  @IsObject()
  data: Record<string, unknown>;
}

export interface IngestResult {
  eventId: string;
  /** true when this eventId was already received; the first payload is kept. */
  duplicate: boolean;
}
