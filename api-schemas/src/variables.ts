import { z } from 'zod';

/**
 * A Service's own runtime variables as the Cloudgate CLI reaches them:
 * named keys set and unset one by one, and their names listed, **never a
 * value** (ADR 0019). Values only ever go in.
 */

/**
 * A variable name: what `dotenv`, which the deploy reads the variables
 * through, reads as a key, so every name that can be set can be read back and
 * unset.
 */
export const variableNameSchema = z
  .string()
  .regex(/^[\w.-]+$/, 'must be a variable name: letters, digits, _, . and -');

/**
 * `PATCH /applications/:id/variables`: the keys to set, with their values,
 * and the keys to unset. Every other variable is left as it is.
 */
export const changeVariablesSchema = z
  .strictObject({
    set: z
      .record(variableNameSchema, z.string().max(65_536))
      .refine((set) => Object.keys(set).length <= 100, 'at most 100 keys')
      .optional(),
    unset: z.array(variableNameSchema).max(100).optional(),
  })
  .refine(
    (body) =>
      Object.keys(body.set ?? {}).length + (body.unset ?? []).length > 0,
    'name at least one variable to set or unset',
  )
  .refine(
    (body) =>
      !(body.unset ?? []).some((name) => Object.hasOwn(body.set ?? {}, name)),
    'a variable is either set or unset, not both',
  );

/**
 * `GET /applications/:id/variables`, and the answer of the `PATCH` beside it:
 * every name, sorted, each with the Output it is linked to (a wired variable,
 * whose value the deploy fills in) or `null` for one set on the Service
 * itself. No value, not even a masked one.
 */
export const variableListSchema = z.object({
  variables: z.array(
    z.object({
      name: z.string(),
      linkedTo: z.object({ source: z.string(), output: z.string() }).nullable(),
    }),
  ),
});

export type ChangeVariables = z.infer<typeof changeVariablesSchema>;
export type VariableList = z.infer<typeof variableListSchema>;
