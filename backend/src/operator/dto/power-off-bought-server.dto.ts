import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `POST /operator/bought-servers/:id/power-off`: the reason the customer
 * is shown on the Server, "Powered off by Cloudgate: <reason>".
 */
export const powerOffBoughtServerSchema = z.object({
  reason: z.string().trim().min(1, 'reason cannot be empty').max(500),
});

export class PowerOffBoughtServerDto extends createZodDto(
  powerOffBoughtServerSchema,
) {}
