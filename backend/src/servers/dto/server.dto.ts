import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { isServerAddress, SERVER_ADDRESS_MESSAGE } from '../server-address';

/** An IP address or a hostname, trimmed, and nothing else. */
const serverAddress = z
  .string()
  .trim()
  .min(1, 'ipAddress cannot be empty')
  .refine(isServerAddress, SERVER_ADDRESS_MESSAGE);

// Create input: name/description/ipAddress/port/username/sshKeyId/serverType.
export const createServerSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  description: z.string().optional(),
  ipAddress: serverAddress,
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).default('root'),
  sshKeyId: z.string().min(1, 'sshKeyId cannot be empty'),
  serverType: z.enum(['deploy', 'build']).optional(),
});

export class CreateServerDto extends createZodDto(createServerSchema) {}

// Update input (partial; serverId travels in the URL).
export const updateServerSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').optional(),
  description: z.string().nullish(),
  ipAddress: serverAddress.optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().min(1).optional(),
  sshKeyId: z.string().min(1).optional(),
  serverType: z.enum(['deploy', 'build']).optional(),
  command: z.string().optional(),
});

export class UpdateServerDto extends createZodDto(updateServerSchema) {}
