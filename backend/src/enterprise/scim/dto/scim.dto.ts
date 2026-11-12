import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * 1–64 lowercase alphanumerics and dashes, starting with an alphanumeric. The
 * provider id is not cosmetic: it
 * is packed into the bearer token between colon separators (which is why the
 * plugin refuses one containing a colon outright) and becomes the
 * `account.providerId` a provisioned user is linked by.
 */
export const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    'Provider ID must be lowercase alphanumeric with optional dashes',
  );

export class GenerateScimTokenDto extends createZodDto(
  z.object({ providerId: providerIdSchema }),
) {}
