import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Protocol defaults to tcp and publish mode to ingress.
export const createPortSchema = z.object({
  publishedPort: z.number().int().min(1).max(65535),
  targetPort: z.number().int().min(1).max(65535),
  protocol: z.enum(['tcp', 'udp']).default('tcp'),
  publishMode: z.enum(['ingress', 'host']).default('ingress'),
  applicationId: z.string().min(1),
});

export class CreatePortDto extends createZodDto(createPortSchema) {}

// Every field optional (portId travels in the URL).
export const updatePortSchema = z
  .object({
    publishedPort: z.number().int().min(1).max(65535),
    targetPort: z.number().int().min(1).max(65535),
    protocol: z.enum(['tcp', 'udp']),
    publishMode: z.enum(['ingress', 'host']),
  })
  .partial();

export class UpdatePortDto extends createZodDto(updatePortSchema) {}

// The parent an application's published ports are listed by; folded into a
// query DTO like ListMountsDto rather than a nested path.
export const listPortsSchema = z.object({
  applicationId: z.string().min(1),
});

export class ListPortsDto extends createZodDto(listPortsSchema) {}
