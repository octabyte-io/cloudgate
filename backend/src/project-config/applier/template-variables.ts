import type { PlanStep } from '../planner/plan.types';
import { dotenvText } from './dotenv-keys';

/**
 * A Template part's variables as a create writes them: each list the plan
 * named a value in, as a dotenv blob, from the values its Pending setup
 * holds. Empty for a create that is not a Template part. A value the plan
 * named and the setup no longer holds fails the step, which leaves the part
 * in the setup for the next plan.
 *
 * Apart from `plan-applier.ts` because only a Template part has any; the
 * Apply's every create spreads it in.
 */
export function templateVariables(
  /** The Apply's values, each Template part's by its Config name. */
  templateValues:
    ReadonlyMap<string, Readonly<Record<string, string>>> | undefined,
  step: Extract<PlanStep, { action: 'create' }>,
): { env?: string; buildArgs?: string; buildSecrets?: string } {
  if (!step.template) return {};
  const values = templateValues?.get(step.configName);
  if (!values) {
    throw new Error(
      `${step.configName}'s Pending setup no longer holds its values; Check for changes`,
    );
  }
  const lists = {
    env: 'env',
    build_args: 'buildArgs',
    build_secrets: 'buildSecrets',
  } as const;
  const grouped: { env?: string; buildArgs?: string; buildSecrets?: string } =
    {};
  for (const [list, field] of Object.entries(lists)) {
    const variables = step.template.values
      .filter((value) => value.list === list && value.variable in values)
      .map((value) => [value.variable, values[value.variable]] as const);
    if (variables.length > 0) grouped[field] = dotenvText(variables);
  }
  return grouped;
}
