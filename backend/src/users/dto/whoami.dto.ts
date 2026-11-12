import { whoamiSchema } from 'api-schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * `GET /users/me/whoami`'s answer, declared for the OpenAPI document only.
 *
 * The schema lives in `api-schemas` because the Cloudgate CLI parses this
 * answer with the same zod object (ADR 0046); the backend keeps the
 * `createZodDto` wrapper here, as every DTO does, so nothing in `api-schemas`
 * depends on Nest.
 */
export class WhoamiDto extends createZodDto(whoamiSchema) {}
