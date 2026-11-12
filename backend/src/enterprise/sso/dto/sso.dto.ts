import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A dotted hostname ending in an alphabetic TLD: these are email domains
 * matched against the address a user signs in with, so a URL or a bare label
 * is not one.
 */
const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

const oidcConfigSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  authorizationEndpoint: z.string().url().optional(),
  tokenEndpoint: z.string().url().optional(),
  userInfoEndpoint: z.string().url().optional(),
  tokenEndpointAuthentication: z
    .enum(['client_secret_post', 'client_secret_basic'])
    .optional(),
  jwksEndpoint: z.string().url().optional(),
  discoveryEndpoint: z.string().url().optional(),
  skipDiscovery: z.boolean().optional(),
  scopes: z.array(z.string()).optional(),
  pkce: z.boolean().optional(),
  mapping: z
    .object({
      id: z.string(),
      email: z.string(),
      emailVerified: z.string().optional(),
      name: z.string(),
      image: z.string().optional(),
      extraFields: z.record(z.string(), z.any()).optional(),
    })
    .optional(),
});

/**
 * The register/update body. The domains are validated here but normalized in
 * the service, which is where the comparison against stored domains happens —
 * a direct service caller must get the same rule.
 */
const ssoProviderBody = z.object({
  providerId: z.string().min(1),
  issuer: z.string().url(),
  domains: z
    .array(z.string())
    .min(1)
    .refine(
      (domains) =>
        domains.every((domain) =>
          domainRegex.test(domain.trim().toLowerCase()),
        ),
      { message: 'Invalid domain' },
    ),
  oidcConfig: oidcConfigSchema.optional(),
  overrideUserInfo: z.boolean().optional(),
});

/**
 * Registration takes one field an update does not: `trustIssuer` adds the
 * issuer's origin to the organization's trusted origins when the plugin refuses
 * to reach it without that, so the first provider on a fresh install can be
 * added in one step.
 */
export class RegisterSsoProviderDto extends createZodDto(
  ssoProviderBody.extend({ trustIssuer: z.boolean().optional() }),
) {}
export class UpdateSsoProviderDto extends createZodDto(ssoProviderBody) {}

export class TrustedOriginDto extends createZodDto(
  z.object({ origin: z.string().min(1) }),
) {}

export class UpdateTrustedOriginDto extends createZodDto(
  z.object({
    oldOrigin: z.string().min(1),
    newOrigin: z.string().min(1),
  }),
) {}

export class EnforceSsoDto extends createZodDto(
  z.object({ enforceSSO: z.boolean() }),
) {}

/**
 * A domain to prove: the rule a provider's domains are held to, since
 * the two are compared. Normalized in the service.
 */
export class ProvenDomainDto extends createZodDto(
  z.object({
    domain: z
      .string()
      .refine((domain) => domainRegex.test(domain.trim().toLowerCase()), {
        message: 'Invalid domain',
      }),
  }),
) {}
