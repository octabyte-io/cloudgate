import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * What a request that still carries a `baseUrl` is told.
 *
 * The field used to name the host the *backend* fetched templates from,
 * unconstrained: a caller-directed fetch out of the platform host, and a
 * template the caller authored while everything downstream treated it as
 * trusted platform data. Which catalogue an instance trusts is an
 * instance-level decision, so the message says where it went rather than only
 * that it is gone.
 */
export const TEMPLATES_BASE_URL_NOT_A_REQUEST_FIELD =
  'baseUrl is no longer a request field: the Template catalogue is set on the ' +
  'instance with CLOUDGATE_TEMPLATES_URL';

/**
 * The whole query string `GET /templates` and `GET /templates/tags` accept:
 * nothing, and `baseUrl` refused by name.
 *
 * Declared as `z.never()` rather than left out, because zod strips unknown
 * keys: a caller's `baseUrl` would be silently ignored, a request that reads
 * as accepted while the backend read somewhere else. It exists only to be
 * validated: the routes read nothing out of it.
 */
export const catalogueQuerySchema = z.object({
  baseUrl: z
    .never({ error: TEMPLATES_BASE_URL_NOT_A_REQUEST_FIELD })
    .optional(),
});

export class CatalogueQueryDto extends createZodDto(catalogueQuerySchema) {}
