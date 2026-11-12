import { aboutSchema } from 'api-schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * `GET /settings/about`'s answer, declared for the OpenAPI document only. The
 * schema lives in `api-schemas` because the Cloudgate CLI parses this answer
 * with the same zod object (ADR 0046).
 */
export class AboutDto extends createZodDto(aboutSchema) {}
