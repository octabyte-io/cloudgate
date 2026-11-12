import { configRepositorySourcesSchema } from 'api-schemas';
import { createZodDto } from 'nestjs-zod';

/**
 * `GET /environments/:environmentId/config/repository-sources`'s answer,
 * declared for the OpenAPI document. The schema lives in `api-schemas`
 * because `cloudgate deploy` parses it with the same zod object (ADR 0046).
 */
export class ConfigRepositorySourcesDto extends createZodDto(
  configRepositorySourcesSchema,
) {}
