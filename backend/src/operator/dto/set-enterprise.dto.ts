import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** One hand-set count of an Enterprise agreement. */
const count = z.number().int().min(0).max(10_000);

/**
 * `PUT /operator/organizations/:id/enterprise`: Enterprise on with the
 * agreement's Server and Cloud Environment counts, or off, which needs none
 * (any sent are ignored). A flat object rather than a discriminated union,
 * which cannot be a `createZodDto` class (see schedule.dto.ts).
 */
export const setEnterpriseSchema = z
  .object({
    enterprise: z.boolean(),
    servers: count.optional(),
    cloudEnvironments: count.optional(),
  })
  .refine(
    (body) =>
      !body.enterprise ||
      (body.servers !== undefined && body.cloudEnvironments !== undefined),
    {
      message:
        'servers and cloudEnvironments are required when enterprise is true',
      path: ['servers'],
    },
  );

export type SetEnterprise = z.infer<typeof setEnterpriseSchema>;

export class SetEnterpriseDto extends createZodDto(setEnterpriseSchema) {}
