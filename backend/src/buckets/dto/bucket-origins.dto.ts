import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A bucket's whole new browser-upload origin list: adding or removing
 * one sends the list as it now stands. Its shape only — whether each is a
 * web origin is the service's to refuse, naming it (`bucket-origins.ts`).
 */
export const putBucketOriginsSchema = z.object({
  origins: z.array(z.string().max(300, 'an origin is at most 300 characters')),
});
export class PutBucketOriginsDto extends createZodDto(putBucketOriginsSchema) {}
