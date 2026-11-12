import {
  deviceCodeRequestSchema,
  deviceCodeSchema,
  deviceTokenRequestSchema,
  deviceTokenSchema,
} from 'api-schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * `cloudgate login`'s bodies and answers. The schemas live in
 * `api-schemas`, which the CLI parses with too (ADR 0046).
 */
export class DeviceCodeRequestDto extends createZodDto(
  deviceCodeRequestSchema,
) {}
export class DeviceCodeDto extends createZodDto(deviceCodeSchema) {}
export class DeviceTokenRequestDto extends createZodDto(
  deviceTokenRequestSchema,
) {}
export class DeviceTokenDto extends createZodDto(deviceTokenSchema) {}
