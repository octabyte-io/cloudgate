import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Create body: a name and an optional color. The name is trimmed before it is
// checked or stored: ` frontend` reads as `frontend` in every list, so
// it must meet the same unique index, and a name of spaces is no name.
export const createTagSchema = z.object({
  name: z.string().trim().min(1, 'name cannot be empty'),
  color: z.string().optional(),
});

export class CreateTagDto extends createZodDto(createTagSchema) {}

// Update body (partial fields; tagId travels in the URL).
export const updateTagSchema = createTagSchema.partial();

export class UpdateTagDto extends createZodDto(updateTagSchema) {}

// GET /tags — optionally narrowed to one project's assigned tags.
export const listTagsSchema = z.object({
  projectId: z.string().min(1).optional(),
});

export class ListTagsDto extends createZodDto(listTagsSchema) {}
