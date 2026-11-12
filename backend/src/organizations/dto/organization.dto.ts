import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createOrganizationSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').max(255),
  logo: z.string().optional(),
  /**
   * Who pays for the new Organization (ADR-0059): `itself`, the default, or
   * `active-organization` — "Add an Organization to this plan", which makes
   * it an Attached Organization of the caller's active Organization. Hosted
   * only.
   */
  paidBy: z.enum(['itself', 'active-organization']).optional(),
});

export class CreateOrganizationDto extends createZodDto(
  createOrganizationSchema,
) {}

export const updateOrganizationSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').max(255),
  logo: z.string().optional(),
});

export class UpdateOrganizationDto extends createZodDto(
  updateOrganizationSchema,
) {}

/**
 * What a caller may know about creating an Organization here, before they try:
 * `GET /organizations/creation`. The console greys out "New organization" from
 * it, with `reason` on one line, so the button and `POST /organizations` say the
 * same thing. Declared once, here, for the OpenAPI document; the service's
 * {@link OrganizationCreation} is inferred from it rather than restated.
 */
export const organizationCreationSchema = z.object({
  /** Whether `POST /organizations` would accept this caller now. */
  allowed: z.boolean(),
  /** Why not, in the words the refusal uses; `null` when allowed. */
  reason: z.string().nullable(),
  /** The refusal's code, when it has one (`ORGANIZATION_LIMIT`). */
  code: z.string().nullable(),
  /**
   * Whether the reader is one of the Instance organization's owners or admins,
   * who can add the license that lifts the limit: the console offers them the
   * way to Settings > License.
   */
  licenseHint: z.boolean(),
  /**
   * Set when this Self-hosted instance already holds more than one
   * Organization without the Instance organization's license, for the open
   * Organization's owners and admins; `null` otherwise. Nothing is removed:
   * the existing Organizations keep working, and only a new one is refused.
   * `count` is how many exist, for the Instance organization's owners and
   * admins only.
   */
  overLimit: z.object({ count: z.number().int().nullable() }).nullable(),
  /**
   * Hosted: how many Organizations that pay for themselves the reader owns,
   * `of` the one a person may — "You own 1 of 1 you can own yourself." Attached
   * Organizations and the Instance organization are not counted. `null` on a
   * Self-hosted instance.
   */
  ownedPayingForThemselves: z
    .object({ count: z.number().int(), of: z.number().int() })
    .nullable(),
  /**
   * Hosted, when refused, for the open Organization's owners and admins only:
   * where a second Organization comes from. `add-to-plan` when the open
   * Organization can pay for one ("Add an Organization to <name>'s plan" on its
   * Billing page), `see-plans` otherwise. `null` for everyone else, and
   * whenever the create would be accepted.
   */
  planHint: z
    .discriminatedUnion('kind', [
      z.object({
        kind: z.literal('add-to-plan'),
        organizationName: z.string(),
      }),
      z.object({ kind: z.literal('see-plans') }),
    ])
    .nullable(),
});

/** What `OrganizationsService.creation` answers. */
export type OrganizationCreation = z.infer<typeof organizationCreationSchema>;

export class OrganizationCreationDto extends createZodDto(
  organizationCreationSchema,
) {}
