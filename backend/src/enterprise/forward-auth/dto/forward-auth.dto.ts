import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** A lowercase hostname — not a URL and not a bare label. */
const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const authDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .refine((value) => domainRegex.test(value), {
    message: 'Invalid auth domain',
  });

/**
 * The target's serverId. Null (or absent, on the query-string routes) means the
 * local server.
 */
const serverIdSchema = z.string().min(1).nullish().default(null);

export const setForwardAuthSettingsSchema = z.object({
  serverId: serverIdSchema,
  authDomain: authDomainSchema,
  https: z.boolean().default(true),
  certificateType: z
    .enum(['none', 'letsencrypt', 'custom'])
    .default('letsencrypt'),
  customCertResolver: z.string().optional(),
});

export class SetForwardAuthSettingsDto extends createZodDto(
  setForwardAuthSettingsSchema,
) {}

export const deployForwardAuthSchema = z.object({
  serverId: serverIdSchema,
  providerId: z.string().min(1),
});

export class DeployForwardAuthDto extends createZodDto(
  deployForwardAuthSchema,
) {}

/** The server target as it arrives on a query string. */
export const forwardAuthServerQuerySchema = z.object({
  serverId: serverIdSchema,
});

export class ForwardAuthServerQueryDto extends createZodDto(
  forwardAuthServerQuerySchema,
) {}
