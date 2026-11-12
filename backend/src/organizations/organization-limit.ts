import { ForbiddenException } from '@nestjs/common';

import type { OrganizationCreation } from './dto/organization.dto';

export type { OrganizationCreation } from './dto/organization.dto';

/**
 * The one-Organization limit's code (ADR-0059). One code for every refusal of a
 * new Organization for being over a limit, so the console and a caller of the
 * API branch on it rather than on the sentence.
 */
export const ORGANIZATION_LIMIT_CODE = 'ORGANIZATION_LIMIT';

/**
 * The refusal of a new Organization over a limit: 403 `ORGANIZATION_LIMIT`
 * with `reason`. The one builder, for the Hosted and Self-hosted limits, the
 * attach and "Pay for it yourself" alike.
 */
export function organizationLimit(reason: string): ForbiddenException {
  return new ForbiddenException({
    code: ORGANIZATION_LIMIT_CODE,
    message: reason,
  });
}

/**
 * Whether an action the console greys out would be accepted, and why not:
 * the refusal as a read says it before anyone clicks, in the route's own
 * words. `GET /organizations/creation`, "Add an Organization to this plan"
 * and "Pay for it yourself" each answer one.
 */
export type RefusalView = Pick<
  OrganizationCreation,
  'allowed' | 'reason' | 'code'
>;

/**
 * {@link RefusalView} for `reason`, null when allowed. `code` is the
 * refusal's, `ORGANIZATION_LIMIT` unless the refusal carries none.
 */
export function refusalViewOf(
  reason: string | null,
  code: string | null = ORGANIZATION_LIMIT_CODE,
): RefusalView {
  if (reason === null) return { allowed: true, reason: null, code: null };
  return { allowed: false, reason, code };
}

/**
 * The Self-hosted refusal, in its two wordings (ADR-0059). The Instance
 * organization's owners and admins are the people who can add a license, so
 * only they are pointed at Settings > License. Everyone else is told who can,
 * and neither wording names another Organization or says how many there are:
 * an owner of one tenant learns nothing about the others from it.
 */
export const SELF_HOSTED_LIMIT_FOR_INSTANCE_STAFF =
  'Without an Enterprise license this instance allows one Organization. Add a license under Settings > License';

export const SELF_HOSTED_LIMIT_FOR_EVERYONE_ELSE =
  "Without an Enterprise license this instance allows one Organization. The instance's administrators can add a license";

/** The Self-hosted refusal's wording for this reader. */
export function selfHostedLimitReason(instanceStaff: boolean): string {
  return instanceStaff
    ? SELF_HOSTED_LIMIT_FOR_INSTANCE_STAFF
    : SELF_HOSTED_LIMIT_FOR_EVERYONE_ELSE;
}

/** The refusal of the existing role check on Self-hosted, word for word. */
export const SELF_HOSTED_CREATE_ROLE_REFUSAL =
  'Only the organization owner can create an organization';

/**
 * The Hosted refusal of a create by an account whose address is not
 * confirmed. It carries no code: it is not a limit.
 */
export const CONFIRM_EMAIL_BEFORE_CREATE_REFUSAL =
  'Confirm your email address before creating an organization';

/** How many Organizations that pay for themselves a person may own (ADR-0059). */
export const HOSTED_OWN_LIMIT = 1;

/**
 * The one-per-person rule as a sentence: the reader already owns `owned`, an
 * Organization that pays for itself. It names only their own Organization,
 * never anyone else's. The create refusal and "Pay for it yourself" both say
 * it.
 */
export function alreadyOwnsOneReason(owned: string): string {
  return `You already own ${owned}, and a person can own one Organization that pays for itself`;
}

/**
 * The upsell sentence, for owners and admins only: `name` cannot pay for
 * others yet, and Business would let it. The create refusal and the attach
 * refusal both end with it.
 */
export function onBusinessUpsell(name: string): string {
  return `On Business, ${name} can pay for more Organizations`;
}

/**
 * Which upsell sentence the Hosted refusal ends with, if any. Only the open
 * Organization's owners and admins get one (ADR-0059): `on-business` when the
 * Organization they own cannot pay for others yet (Starter, no plan, a move to
 * Starter waiting), `on-its-plan` when it already can.
 */
export type HostedLimitUpsell = 'on-business' | 'on-its-plan' | null;

/**
 * The Hosted refusal of "New organization" (ADR-0059): the caller already owns
 * `owned`, an Organization that pays for itself.
 */
export function hostedLimitReason(
  owned: string,
  upsell: HostedLimitUpsell,
): string {
  const reason = alreadyOwnsOneReason(owned);
  if (upsell === 'on-business') {
    return `${reason}. ${onBusinessUpsell(owned)}`;
  }
  if (upsell === 'on-its-plan') {
    return `${reason}. ${owned} can pay for more Organizations on its plan`;
  }
  return reason;
}
