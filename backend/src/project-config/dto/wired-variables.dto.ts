import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { CONFIG_NAME_REGEX } from '../format/config-schema';

/**
 * A Service's wired variables as the console saves them: the whole
 * set, each a variable name and the source and Output it links to. A name
 * left out is unlinked. Whether a source hands out that Output where the
 * Service can reach it is the plan's to say, not this schema's.
 */
export const saveLinksSchema = z.object({
  links: z
    .array(
      z.strictObject({
        name: z
          .string()
          .regex(/^[^\s=]+$/, 'must be a variable name, with no value'),
        source: z.string().regex(CONFIG_NAME_REGEX, 'must be a Config name'),
        output: z
          .string()
          .regex(/^[a-z][a-z_]*$/, 'must be an Output name, e.g. url'),
      }),
    )
    .max(200)
    .refine(
      (links) => new Set(links.map((link) => link.name)).size === links.length,
      'a variable is linked once',
    ),
});

export class SaveLinksDto extends createZodDto(saveLinksSchema) {}
