import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { keyPairIssues } from '../ssh-key-pair';

// The key types a generated keypair can have.
export const sshKeyTypeSchema = z.enum(['rsa', 'ed25519']);

export type SshKeyType = z.infer<typeof sshKeyTypeSchema>;

// Create body; a missing keypair is generated server-side, and a pasted one
// must be a usable pair — `keyPairIssues` says why, on the field.
export const createSshKeySchema = z
  .object({
    name: z.string().min(1, 'name cannot be empty'),
    description: z.string().optional(),
    publicKey: z.string().min(1, 'publicKey cannot be empty').optional(),
    privateKey: z.string().min(1, 'privateKey cannot be empty').optional(),
    type: sshKeyTypeSchema.optional(),
  })
  .superRefine(({ publicKey, privateKey }, ctx) => {
    for (const issue of keyPairIssues(publicKey, privateKey)) {
      ctx.addIssue({
        code: 'custom',
        path: [issue.path],
        message: issue.message,
      });
    }
  });

export class CreateSshKeyDto extends createZodDto(createSshKeySchema) {}

// Update body (name/description/lastUsedAt, partial; the keypair itself is
// immutable and sshKeyId travels in the URL).
export const updateSshKeySchema = z.object({
  name: z.string().min(1, 'name cannot be empty').optional(),
  description: z.string().nullish(),
  lastUsedAt: z.string().nullish(),
});

export class UpdateSshKeyDto extends createZodDto(updateSshKeySchema) {}
