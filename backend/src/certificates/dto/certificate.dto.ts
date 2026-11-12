import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Name and PEM blobs required, serverId optional. certificatePath is always
// server-generated.
//
// autoRenew is deliberately absent: nothing ever renewed a
// stored certificate — it is material somebody pasted in, and renewing it
// means pasting the next one. An old client that still sends the flag is not
// rejected; z.object strips unknown keys, so it is silently ignored.
export const createCertificateSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  certificateData: z.string().min(1, 'certificateData cannot be empty'),
  privateKey: z.string().min(1, 'privateKey cannot be empty'),
  serverId: z.string().nullish(),
});

export class CreateCertificateDto extends createZodDto(
  createCertificateSchema,
) {}

// Only the name and the PEM material can change (certificateId travels in the
// URL).
export const updateCertificateSchema = z
  .object({
    name: z.string().min(1),
    certificateData: z.string().min(1),
    privateKey: z.string().min(1),
  })
  .partial();

export class UpdateCertificateDto extends createZodDto(
  updateCertificateSchema,
) {}
