import type { InstanceModeName } from 'api-schemas';
import { z } from 'zod';

export type { InstanceModeName } from 'api-schemas';

/**
 * Hosted mode, the setting and its boot check (ADR-0049).
 *
 * `HOSTED_MODE=true` turns an Instance into the Hosted instance; unset or
 * `false` is a Self-hosted instance. It replaces `IS_CLOUD`. This directory is
 * the only code that reads either name, which
 * `test/coding-standards/instance-mode-reads.spec.ts` holds: everything else
 * asks `InstanceMode` (`./instance-mode.service.ts`).
 *
 * Plain functions over the environment and nothing else, so the boot check is
 * a unit and runs before Nest has built anything.
 */

/**
 * The env-schema field, spread into `envSchema` so the schema does not spell
 * the name itself. Validated to a boolean; blank is off, because systemd hands
 * a bare `HOSTED_MODE=` through as an empty string.
 */
export const instanceModeEnv = {
  HOSTED_MODE: z
    .enum(['true', 'false', ''])
    .optional()
    .transform((value) => value === 'true'),
};

/**
 * What a hosted boot refuses to start without, in the order the message names
 * them. Each is a fact about the environment and a sentence for the operator.
 */
const HOSTED_REQUIREMENTS: ReadonlyArray<{
  missing: (env: Record<string, unknown>) => boolean;
  says: string;
}> = [
  required('STRIPE_SECRET_KEY', 'the Stripe secret key'),
  required('STRIPE_WEBHOOK_SECRET', 'the Stripe webhook secret'),
  required('STARTER_PLAN_PRICE_ID', 'the Starter plan price id'),
  required('BUSINESS_PLAN_PRICE_ID', 'the Business plan price id'),
  required('ADD_ON_PRICE_ID', 'the Add-on price id'),
  {
    missing: (env) => text(env.MAIL_PROVIDER) !== 'resend',
    says: 'MAIL_PROVIDER=resend (mail is sent through Resend)',
  },
  required('MAIL_FROM_ADDRESS', 'the Resend sender address'),
  required('RESEND_API_KEY', 'the Resend API key'),
  required('SITE_URL', "the console's public address"),
  required('TURNSTILE_SITE_KEY', 'the Cloudflare Turnstile site key'),
  required('TURNSTILE_SECRET_KEY', 'the Cloudflare Turnstile secret key'),
];

function required(
  key: string,
  what: string,
): (typeof HOSTED_REQUIREMENTS)[number] {
  return { missing: (env) => text(env[key]) === '', says: `${key} (${what})` };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** A boot the instance-mode check refuses; its message is the whole story. */
export class InstanceModeBootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstanceModeBootError';
  }
}

/**
 * The boot check: the mode this environment runs in, or a refusal.
 *
 * - A stale `IS_CLOUD`, whatever its value, refuses and says it was renamed,
 *   so an old environment file cannot quietly run in either mode.
 * - A `HOSTED_MODE` other than `true`/`false`/blank refuses.
 * - Hosted: refuses while anything in {@link HOSTED_REQUIREMENTS} is missing,
 *   naming all of it in one message, so it is fixed in one pass.
 * - Self-hosted: Stripe, price and mail settings are not looked at.
 * - Given the recorded mode, refuses a setting that disagrees with it
 *   ({@link checkRecordedMode}). `validateEnv` runs before there is a
 *   database and passes none; the boot provider in `./recorded-mode.ts`
 *   compares the row once it can read it.
 */
export function checkInstanceModeBoot(
  env: Record<string, unknown>,
  recorded?: InstanceModeName | null,
): InstanceModeName {
  const configured = configuredMode(env);
  if (recorded !== undefined) checkRecordedMode(configured, recorded);
  return configured;
}

function configuredMode(env: Record<string, unknown>): InstanceModeName {
  if (text(env.IS_CLOUD) !== '') {
    throw new InstanceModeBootError(
      'IS_CLOUD was renamed to HOSTED_MODE. Remove IS_CLOUD from the ' +
        'environment, and set HOSTED_MODE=true on the Hosted instance or ' +
        'leave it unset on a Self-hosted one.',
    );
  }

  const setting = text(env.HOSTED_MODE);
  if (setting !== '' && setting !== 'true' && setting !== 'false') {
    throw new InstanceModeBootError(
      `HOSTED_MODE must be "true" or "false" (or unset), not "${setting}".`,
    );
  }
  if (setting !== 'true') return 'self-hosted';

  const missing = HOSTED_REQUIREMENTS.filter((item) => item.missing(env));
  if (missing.length > 0) {
    throw new InstanceModeBootError(
      'HOSTED_MODE=true, but the Hosted instance cannot start without:\n' +
        missing.map((item) => `  - ${item.says}`).join('\n'),
    );
  }
  return 'hosted';
}

/** The command that changes the recorded mode on purpose. */
export const SET_INSTANCE_MODE_COMMAND = 'set-instance-mode';

/**
 * The recorded-mode half of the boot check (ADR-0049): a start whose
 * setting disagrees with the mode the database recorded refuses, naming both,
 * so an `install.sh` re-run that drops `HOSTED_MODE` cannot turn the Hosted
 * instance into a Self-hosted one with an open platform host. No record yet
 * (the first start, or the first after the upgrade that added it) passes, and
 * the caller records the configured mode.
 */
export function checkRecordedMode(
  configured: InstanceModeName,
  recorded: InstanceModeName | null,
): void {
  if (recorded === null || recorded === configured) return;
  throw new InstanceModeBootError(
    `This Instance's recorded mode is ${recorded}, but its setting says ` +
      `${configured} (${instanceModeSetting(configured)}). Refusing to start in a ` +
      'mode the database did not record. If the setting was lost, set ' +
      `${instanceModeSetting(recorded)} again. To change the mode on purpose, run ` +
      `\`node dist/commands/${SET_INSTANCE_MODE_COMMAND}.js --mode ` +
      `${configured}\` on the platform host first.`,
  );
}

/**
 * How the environment spells `mode`, for a sentence to name: the refusal
 * above, and what `set-instance-mode` tells its operator to set next.
 */
export function instanceModeSetting(mode: InstanceModeName): string {
  return mode === 'hosted' ? 'HOSTED_MODE=true' : 'HOSTED_MODE unset';
}
