import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Which application's Traefik verdict to read. One field, and it is the
 * application rather than the Domain: Traefik refuses a *router*, one file
 * carries every Domain of an application, and a rejection anywhere in it can
 * darken a Domain that has nothing wrong with it.
 */
export const traefikConfigStatusQuerySchema = z.object({
  applicationId: z.string().min(1, 'applicationId cannot be empty'),
});
export class TraefikConfigStatusQueryDto extends createZodDto(
  traefikConfigStatusQuerySchema,
) {}
