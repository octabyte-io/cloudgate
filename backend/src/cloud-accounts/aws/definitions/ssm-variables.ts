import { createHmac } from 'node:crypto';

import type { PlanRefusal } from '../../../project-config';

/**
 * A cloud Service's variables as SSM parameters (the AWS spec "Variables").
 * Pure: no AWS call, no `tofu`, no database.
 *
 * Each variable with a value is one SSM `SecureString`, named
 * {@link ssmParameterName}, kept in the Service's own state and referenced
 * from the task definition's `secrets`. Its value reaches `tofu` only as a
 * `sensitive` variable passed in the environment (`TF_VAR_…`), never in
 * `main.tf.json`, so it shows in no plan, log or task definition revision.
 */

/** SSM's Standard tier holds a value of up to 4 KB (bytes of UTF-8). */
export const STANDARD_MAX_BYTES = 4096;

/** SSM's Advanced tier holds up to 8 KB; anything larger the plan refuses. */
export const ADVANCED_MAX_BYTES = 8192;

/** What an SSM parameter name may hold past its `/` separators. */
const SSM_NAME_CHARACTERS = /^[A-Za-z0-9_.-]+$/;

/** The label the digest key is derived under, beside `cloudgate:db-encryption:v1`. */
export const VARIABLES_DIGEST_LABEL = 'cloudgate:variables-digest:v1';

/** The `tofu` variable that carries the digest into the ECS service's `triggers`. */
export const DIGEST_VARIABLE = 'variables_digest';

/** `/cloudgate/<environment id>/<service id>/<VARIABLE>`. */
export function ssmParameterName(
  environmentId: string,
  serviceId: string,
  variable: string,
): string {
  return `/cloudgate/${environmentId}/${serviceId}/${variable}`;
}

/** How one variable reaches the task. */
export type VariablePlacement =
  | {
      readonly name: string;
      /** An empty value: a plain `environment` entry, no parameter. */
      readonly kind: 'plain';
    }
  | {
      readonly name: string;
      readonly kind: 'secure';
      /** `Advanced` above 4 KB, at $0.05/month, which the plan line shows. */
      readonly tier: 'Standard' | 'Advanced';
    };

/**
 * Where each variable goes, sorted by name, or the refusal of the first
 * one SSM cannot hold: a value over 8 KB, or a name with a character an
 * SSM parameter name cannot carry. Sizes are bytes of UTF-8, as SSM counts
 * them, not characters.
 */
export function placeVariables(
  configName: string,
  values: Readonly<Record<string, string>>,
):
  | { readonly ok: true; readonly placements: VariablePlacement[] }
  | { readonly ok: false; readonly refusal: PlanRefusal } {
  const placements: VariablePlacement[] = [];
  for (const name of Object.keys(values).sort()) {
    const at = `${configName}.env`;
    if (!SSM_NAME_CHARACTERS.test(name)) {
      return {
        ok: false,
        refusal: {
          at,
          message: `${configName}'s variable ${name} cannot be an SSM parameter name: use letters, digits, _, . and - only`,
        },
      };
    }
    const value = values[name];
    const bytes = Buffer.byteLength(value, 'utf8');
    if (bytes > ADVANCED_MAX_BYTES) {
      return {
        ok: false,
        refusal: {
          at,
          message: `${configName}'s variable ${name} is ${bytes} bytes, and SSM holds at most ${ADVANCED_MAX_BYTES} (8 KB). Shorten it, or keep it elsewhere and pass its location`,
        },
      };
    }
    if (bytes === 0) {
      placements.push({ name, kind: 'plain' });
      continue;
    }
    placements.push({
      name,
      kind: 'secure',
      tier: bytes > STANDARD_MAX_BYTES ? 'Advanced' : 'Standard',
    });
  }
  return { ok: true, placements };
}

/**
 * An HMAC-SHA256 of every name and value, under a key derived from
 * Cloudgate's secret (`APP_ENCRYPTION_SECRET`) the way the column key is.
 * It sits in the ECS service's `triggers`, so any changed value rolls the
 * tasks, and is kept only in the encrypted state: keyed, it says nothing
 * of a value to whoever reads it without the secret.
 */
export function variablesDigest(
  secret: string,
  values: Readonly<Record<string, string>>,
): string {
  if (!secret) {
    throw new Error(
      "APP_ENCRYPTION_SECRET is not set; a Service's variables cannot be digested without it.",
    );
  }
  const key = createHmac('sha256', secret)
    .update(VARIABLES_DIGEST_LABEL)
    .digest();
  const canonical = JSON.stringify(
    Object.keys(values)
      .sort()
      .map((name) => [name, values[name]]),
  );
  return createHmac('sha256', key).update(canonical).digest('hex');
}
