import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `PUT /operator/bought-servers/settings`: the Server markup, the margin
 * floor, or both, in whole percent. A markup prices new purchases and new
 * lines only; the floor only flags.
 */
export const setBoughtServerSettingsSchema = z
  .object({
    markupPercent: z.number().int().min(0).max(1000).optional(),
    marginFloorPercent: z.number().int().min(0).max(100).optional(),
  })
  .refine(
    (body) =>
      body.markupPercent !== undefined || body.marginFloorPercent !== undefined,
    {
      message: 'markupPercent or marginFloorPercent is required',
      path: ['markupPercent'],
    },
  );

export type SetBoughtServerSettings = z.infer<
  typeof setBoughtServerSettingsSchema
>;

export class SetBoughtServerSettingsDto extends createZodDto(
  setBoughtServerSettingsSchema,
) {}
