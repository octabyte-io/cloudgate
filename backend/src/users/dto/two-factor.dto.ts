import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const twoFactorPasswordSchema = z.object({
  password: z.string().min(1, 'password is required'),
});

export const verifyTwoFactorSchema = z.object({
  code: z.string().min(1, 'code is required'),
});

export class TwoFactorPasswordDto extends createZodDto(
  twoFactorPasswordSchema,
) {}

export class VerifyTwoFactorDto extends createZodDto(verifyTwoFactorSchema) {}
