import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const activateLicenseSchema = z.object({
  licenseKey: z.string().min(1),
});

export class ActivateLicenseDto extends createZodDto(activateLicenseSchema) {}

// `enableEnterpriseFeatures` is required, so omitting it is a 400 from the
// validation pipe.
export const updateEnterpriseSettingsSchema = z.object({
  enableEnterpriseFeatures: z.boolean(),
});

export class UpdateEnterpriseSettingsDto extends createZodDto(
  updateEnterpriseSettingsSchema,
) {}
