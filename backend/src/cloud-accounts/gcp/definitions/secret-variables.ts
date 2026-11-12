import { serviceName } from './names';
import type { PlanRefusal } from '../../../project-config';

/**
 * A Cloud Run Service's variables as Secret Manager secrets (the Google Cloud spec,
 * "Variables", S1; copying AWS's SSM variables). Pure: no Google call, no `tofu`.
 *
 * Each variable with a value is one secret, named {@link secretName}, with
 * one version holding the value, kept in the Service's own state and
 * referenced by version number from the revision. Its value reaches `tofu`
 * only as a `sensitive` variable passed as `TF_VAR_…`, never in
 * `main.tf.json`. An empty value is a plain environment entry: there is
 * nothing to keep secret.
 */

/** Secret Manager holds a version's payload of up to 64 KiB. */
export const SECRET_MAX_BYTES = 65536;

/** What a secret id may hold: Secret Manager's own rule. */
const SECRET_ID_CHARACTERS = /^[A-Za-z0-9_-]+$/;

/** Secret Manager's longest secret id. */
const SECRET_ID_MAX_LENGTH = 255;

/**
 * The names Cloud Run sets itself and refuses on a revision: the port the
 * container listens on and the three that name the revision.
 */
export const CLOUD_RUN_RESERVED_VARIABLES: readonly string[] = [
  'PORT',
  'K_SERVICE',
  'K_REVISION',
  'K_CONFIGURATION',
];

/** `cloudgate-<service key>-<variable name>` (S4). */
export function secretName(serviceId: string, variable: string): string {
  return `${serviceName(serviceId)}-${variable}`;
}

/** How one variable reaches the revision. */
export interface SecretPlacement {
  readonly name: string;
  /** `secret` for a value; `plain` for an empty one, with no secret. */
  readonly kind: 'secret' | 'plain';
}

/**
 * Where each variable goes, sorted by name, or the refusal of the first
 * one Google cannot hold: a name a secret id or Cloud Run cannot take, or a
 * value over 64 KiB (bytes of UTF-8, as Secret Manager counts them).
 */
export function placeSecrets(
  configName: string,
  serviceId: string,
  values: Readonly<Record<string, string>>,
):
  | { readonly ok: true; readonly placements: SecretPlacement[] }
  | { readonly ok: false; readonly refusal: PlanRefusal } {
  const at = `${configName}.env`;
  const refuse = (message: string) =>
    ({ ok: false, refusal: { at, message } }) as const;
  const placements: SecretPlacement[] = [];
  for (const name of Object.keys(values).sort()) {
    if (CLOUD_RUN_RESERVED_VARIABLES.includes(name)) {
      return refuse(
        `${configName}'s variable ${name} is set by Cloud Run itself and cannot be given`,
      );
    }
    if (
      !SECRET_ID_CHARACTERS.test(name) ||
      secretName(serviceId, name).length > SECRET_ID_MAX_LENGTH
    ) {
      return refuse(
        `${configName}'s variable ${name} cannot be a Secret Manager secret name: use letters, digits, _ and - only, at most ${SECRET_ID_MAX_LENGTH - secretName(serviceId, '').length} characters`,
      );
    }
    const bytes = Buffer.byteLength(values[name], 'utf8');
    if (bytes > SECRET_MAX_BYTES) {
      return refuse(
        `${configName}'s variable ${name} is ${bytes} bytes, and Secret Manager holds at most ${SECRET_MAX_BYTES} (64 KB). Shorten it, or keep it elsewhere and pass its location`,
      );
    }
    placements.push({ name, kind: bytes === 0 ? 'plain' : 'secret' });
  }
  return { ok: true, placements };
}
