import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Mirrors the domain router's validateDomain input.
export const validateDomainSchema = z.object({
  domain: z.string(),
  serverIp: z.string().optional(),
});

export class ValidateDomainDto extends createZodDto(validateDomainSchema) {}
