import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createTeamSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').max(255),
});

export class CreateTeamDto extends createZodDto(createTeamSchema) {}

export const addTeamMemberSchema = z.object({
  userId: z.string().min(1),
});

export class AddTeamMemberDto extends createZodDto(addTeamMemberSchema) {}
