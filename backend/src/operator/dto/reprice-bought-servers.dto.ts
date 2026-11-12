import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/** `POST /operator/bought-servers/reprice/preview`: the Bought Servers chosen. */
export const previewRepriceSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1, 'choose at least one Bought Server')
    .max(500),
});

export class PreviewRepriceDto extends createZodDto(previewRepriceSchema) {}

/**
 * `POST /operator/bought-servers/reprice`: each Bought Server with the new
 * monthly price its preview showed, in US cents. The reprice is refused
 * unless each still comes to that price.
 */
export const applyRepriceSchema = z.object({
  servers: z
    .array(
      z.object({
        id: z.string().min(1),
        newMonthlyCents: z.number().int().min(0),
      }),
    )
    .min(1, 'choose at least one Bought Server')
    .max(500)
    .refine(
      (servers) =>
        new Set(servers.map((server) => server.id)).size === servers.length,
      { message: 'each Bought Server only once' },
    ),
});

export type ApplyReprice = z.infer<typeof applyRepriceSchema>;

export class ApplyRepriceDto extends createZodDto(applyRepriceSchema) {}
