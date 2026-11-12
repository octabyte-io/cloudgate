import type { FieldDiff, PlanRefusal } from './plan.types';

/**
 * What a cloud database's change planner does with one field a plan
 * compares (`FIELDS[kind]` in `plan-environment.ts`):
 *
 * - `moves`: the planner moves the cloud's instance to it (a size, a
 *   version).
 * - `row`: Cloudgate's alone, written to the Service's row with nothing to
 *   do in the cloud (a description).
 * - `fixed`: set when the instance is made and never moved after, so
 *   changing it refuses (`fixedWhenMadeRefusals`) rather than reaching
 *   Apply, which would write it to the row and wire apps to a user or
 *   database the cloud does not have.
 *
 * Each planner states one for every field its kind compares, and the
 * census (`cloud-change-fields.spec.ts`) fails the build on a field it
 * does not state, so a new field never passes through to the row unread.
 */
export type CloudChangeField = 'moves' | 'row' | 'fixed';

export type CloudChangeFields = Readonly<Record<string, CloudChangeField>>;

/** The cloud product a `fixed` refusal names, and its words for each field. */
const FIXED_NOUNS = {
  RDS: { a: 'an', user: 'master user', database: 'initial database' },
  'Cloud SQL': { a: 'a', user: 'user', database: 'database' },
} as const;

export type FixedWhenMadeProduct = keyof typeof FIXED_NOUNS;

/**
 * The refusal of each diff in `fields` its planner's `changeFields` states
 * as `fixed`:
 * `<name>.<field>: a|an <product> instance's <noun> is fixed when it is made;
 * keep <field>: <from>`. The one rule RDS and Cloud SQL both refuse by, so
 * the two cannot drift apart.
 */
export function fixedWhenMadeRefusals(
  name: string,
  fields: readonly FieldDiff[],
  changeFields: CloudChangeFields,
  product: FixedWhenMadeProduct,
): PlanRefusal[] {
  const { a, ...nouns }: Readonly<Record<string, string>> =
    FIXED_NOUNS[product];
  return fields
    .filter((diff) => changeFields[diff.field] === 'fixed')
    .map((diff) => ({
      at: `${name}.${diff.field}`,
      message: `${name}.${diff.field}: ${a} ${product} instance's ${nouns[diff.field] ?? diff.field} is fixed when it is made; keep ${diff.field}: ${String(diff.from)}`,
    }));
}
