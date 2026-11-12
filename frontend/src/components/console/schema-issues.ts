import type { ZodType } from "zod";

/**
 * A schema's refusals, one sentence per field, for a dialog that holds its
 * values in state rather than in `useApiForm`.
 *
 * The console has one pattern for an empty or malformed field: submit stays
 * on, and the schema's sentence appears under the field. `useApiForm` gives a
 * form that for free. A dialog whose values live in `useState` — usually
 * because they are seeded from a previous step — passes these to each
 * `Field`'s `error` prop instead, which is what `Field` renders outside a
 * `FormProvider`. `null` when the values pass.
 */
export function schemaIssues<Values>(
  schema: ZodType<Values>,
  values: unknown,
): Record<string, string> | null {
  const result = schema.safeParse(values);
  if (result.success) return null;
  const issues: Record<string, string> = {};
  for (const issue of result.error.issues) {
    const field = String(issue.path[0] ?? "");
    issues[field] ??= issue.message;
  }
  return issues;
}
