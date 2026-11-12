import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Create input: a name, plus an optional description and env. The name is
// trimmed before it is stored: it is unique in the organization by
// `lower(name)`, and `staging ` beside `staging` would be two rows nobody can
// tell apart.
export const createProjectSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty'),
  description: z.string().optional(),
  env: z.string().optional(),
});

export class CreateProjectDto extends createZodDto(createProjectSchema) {}

// Update input (partial fields; projectId travels in the URL, not the
// body).
export const updateProjectSchema = createProjectSchema.partial();

export class UpdateProjectDto extends createZodDto(updateProjectSchema) {}
