import { eq } from 'drizzle-orm';
import type { DrizzleDB } from '../db/drizzle.module';
import { member } from '../organizations/organizations.schema';
import { instanceOrganization } from '../rbac/instance-organization.schema';

/**
 * Whether this instance has been claimed: an Instance organization is pinned
 * (ADR-0077), or — the belt to that brace — any owner `member` row exists.
 *
 * The pin is what names the Instance organization and grants instance
 * authority (`PermissionService.instanceOrganizationId`); this only answers
 * "is the instance claimed yet", and it stays claimed once either is true. So
 * a pinned Organization that has lost its owner rows does not reopen a
 * Self-hosted instance to a first sign-up, and an owner row with no pin (an
 * install the back-fill found nobody on, then an older backend wrote to) does
 * not either: both fail closed, with nobody holding instance authority.
 *
 * The single source of the "is this instance claimed yet" question, so the
 * `@Public()` read the sign-up screen asks (`GET /auth/sign-up-open`),
 * the refusal in `assertSignUpAllowed`, the first-sign-up bootstrap and the
 * Instance-organization command can never disagree.
 *
 * Its own module, with no better-auth import, so the box-side command can ask
 * it without loading the auth configuration.
 */
export async function hasInstanceOwner(
  db: Pick<DrizzleDB, 'select'>,
): Promise<boolean> {
  const [pinned] = await db
    .select({ id: instanceOrganization.id })
    .from(instanceOrganization)
    .limit(1);
  if (pinned) return true;
  const [ownerMember] = await db
    .select({ id: member.id })
    .from(member)
    .where(eq(member.role, 'owner'))
    .limit(1);
  return Boolean(ownerMember);
}

/**
 * What an *uninvited* sign-up meets on this instance. An invited one
 * is authorised by its token whatever this says.
 *
 * - `unclaimed` — Self-hosted, no owner yet: the first sign-up owns the
 *   instance (ADR-0013).
 * - `closed` — Self-hosted, owned: accounts are made by invitation.
 * - `not-open-yet` — Hosted, no Instance organization yet: refused, so nobody
 *   on the internet can race Octabyte to instance authority. The Instance
 *   organization is made by `create-instance-organization` on the platform
 *   host (ADR-0051).
 * - `open` — Hosted, the Instance organization exists: anyone may sign up.
 */
export type SignUpState = 'unclaimed' | 'closed' | 'not-open-yet' | 'open';

export function signUpState(hosted: boolean, hasOwner: boolean): SignUpState {
  if (hosted) return hasOwner ? 'open' : 'not-open-yet';
  return hasOwner ? 'closed' : 'unclaimed';
}

/** Whether an uninvited sign-up is accepted in this state. */
export function acceptsUninvitedSignUp(state: SignUpState): boolean {
  return state === 'unclaimed' || state === 'open';
}

/** The refusal of a sign-up on a Hosted instance with no Instance organization. */
export const SIGN_UP_NOT_OPEN_YET_CODE = 'SIGN_UP_NOT_OPEN_YET';
export const SIGN_UP_NOT_OPEN_YET_MESSAGE = 'Sign-up is not open yet';
