import { timingSafeEqual } from 'node:crypto';
import { APIError } from 'better-auth/api';
import { and, eq } from 'drizzle-orm';
import { account, user as userTable } from '../../auth/auth.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import type { PaidFeatureCheck } from '../sso/sso-sign-in';
import { member } from '../../organizations/organizations.schema';
import { scimError } from './scim-wire';
import { scimProvider } from './scim.schema';

/**
 * SCIM below the paid features: refuse adding, always allow removing
 * (ADR-0054).
 *
 * The IdP-facing half of SCIM is better-auth's plugin, which authenticates with
 * a provider's bearer token and knows nothing of plans or license keys. So the
 * paid-feature check is asked here, from `auth.config.ts`'s top-level `before`
 * hook, of the two pushes that add or widen access:
 *
 * - `POST /scim/v2/Users`, a create. It is refused whatever it would have done,
 *   so reviving a tombstone (`scim-tombstone.ts`: delete, then create again)
 *   is refused with it and is no way round the refusal.
 * - `PUT` or `PATCH /scim/v2/Users/:userId` that sets `active` to anything but
 *   false on a user this provider provisioned who is deactivated now: a
 *   reactivation. The same update on a user who is already active changes no
 *   access, so it goes through, which is what keeps an IdP's routine full-`PUT`
 *   of `active: true` with a renamed person working.
 *
 * Everything else reaches the plugin as before: deactivation (`active: false`),
 * delete, renames and reads. Members SCIM already made stay normal members.
 * A request whose token does not authenticate is left for the plugin to refuse
 * as 401, so nothing here answers or records anything for a caller who does
 * not hold the provider's token.
 *
 * A refusal is stored on the provider row (`lastRefusedAddAt`,
 * `lastRefusedAddEmail`), the newest overwriting, for the SCIM page.
 */

/** What the before hook sees of a request; better-call's context, loosely. */
export interface ScimRequestContext {
  path?: string;
  method?: string;
  request?: { method: string };
  params?: Record<string, unknown>;
  body?: unknown;
  headers?: Headers;
}

export interface ScimPlanGateOptions {
  paidFeatures: PaidFeatureCheck;
  instanceMode: { readonly isHosted: boolean };
}

/** A push that would add or widen access, before it is checked against the row. */
export type ScimAdd =
  { kind: 'create'; email: string } | { kind: 'reactivate'; userId: string };

const USERS_PATH = '/scim/v2/Users';
const USER_PATH = '/scim/v2/Users/:userId';

/** The refusal's `detail`, which is what an IdP shows its admin. */
export function scimAddRefusalDetail(instanceMode: {
  readonly isHosted: boolean;
}): string {
  return instanceMode.isHosted
    ? 'Adding members through SCIM comes with the Business plan. Deactivations and deletions are still accepted'
    : 'Adding members through SCIM needs a valid enterprise license. Deactivations and deletions are still accepted';
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The address the plugin would provision: the primary email, else the first,
 * else `userName`, lower-cased (`getUserPrimaryEmail`). Null when the body
 * carries none, which the plugin's own validation refuses anyway.
 */
function createEmailOf(body: unknown): string | null {
  if (!isObject(body)) return null;
  const emails = Array.isArray(body.emails) ? body.emails : [];
  const primary = emails.find((e) => isObject(e) && e.primary === true) as
    Record<string, unknown> | undefined;
  const first = emails[0] as unknown;
  const value =
    primary?.value ??
    (isObject(first) ? first.value : undefined) ??
    body.userName;
  return typeof value === 'string' && value !== '' ? value.toLowerCase() : null;
}

/**
 * Whether a PATCH value sets `/active` to anything the plugin reads as active,
 * walked the way the plugin applies a patch (`applyPatchValue`): a nested
 * object is followed key by key, `.` in a path is `/`, and only `false` or
 * `"false"` deactivates.
 */
function setsActive(value: unknown, path: string | undefined): boolean {
  if (isObject(value)) {
    return Object.entries(value).some(([key, nested]) =>
      setsActive(nested, path ? `${path}.${key}` : key),
    );
  }
  if (!path) return false;
  const normalized = `/${(path.startsWith('/') ? path.slice(1) : path).replaceAll('.', '/')}`;
  return normalized === '/active' && value !== false && value !== 'false';
}

function patchSetsActive(body: unknown): boolean {
  if (!isObject(body) || !Array.isArray(body.Operations)) return false;
  return body.Operations.some((operation: unknown) => {
    if (!isObject(operation)) return false;
    const op =
      typeof operation.op === 'string' ? operation.op.toLowerCase() : 'replace';
    if (op !== 'add' && op !== 'replace') return false;
    const path =
      typeof operation.path === 'string' ? operation.path : undefined;
    return setsActive(operation.value, path);
  });
}

/**
 * The push this request would make if it adds or widens access, read off the
 * request alone; null for everything else, which is never refused.
 */
export function scimAddOf(ctx: ScimRequestContext): ScimAdd | null {
  const method = (ctx.method ?? ctx.request?.method ?? '').toUpperCase();
  if (ctx.path === USERS_PATH && method === 'POST') {
    const email = createEmailOf(ctx.body);
    return email ? { kind: 'create', email } : null;
  }
  if (ctx.path !== USER_PATH) return null;
  const userId = ctx.params?.userId;
  if (typeof userId !== 'string' || userId === '') return null;
  const reactivating =
    method === 'PUT'
      ? isObject(ctx.body) &&
        ctx.body.active !== undefined &&
        ctx.body.active !== false
      : method === 'PATCH' && patchSetsActive(ctx.body);
  return reactivating ? { kind: 'reactivate', userId } : null;
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The provider the bearer token authenticates as, the plugin's way
 * (`authMiddlewareFactory`): base64url of `secret:providerId[:organizationId]`,
 * matched by provider id and the stored (decrypted) secret. Null for anything
 * that would not get past the plugin.
 */
async function authenticatedProvider(
  db: DrizzleDB,
  headers: Headers | undefined,
): Promise<{ id: string; providerId: string; organizationId: string } | null> {
  const bearer = headers?.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!bearer) return null;
  const parts = Buffer.from(bearer, 'base64url').toString('utf8').split(':');
  const [secret, providerId] = parts;
  const organizationId = parts.slice(2).join(':');
  if (!secret || !providerId) return null;
  const [row] = await db
    .select({
      id: scimProvider.id,
      providerId: scimProvider.providerId,
      organizationId: scimProvider.organizationId,
      scimToken: scimProvider.scimToken,
    })
    .from(scimProvider)
    .where(
      and(
        eq(scimProvider.providerId, providerId),
        ...(organizationId
          ? [eq(scimProvider.organizationId, organizationId)]
          : []),
      ),
    )
    .limit(1);
  if (!row?.organizationId || !sameSecret(row.scimToken, secret)) return null;
  return {
    id: row.id,
    providerId: row.providerId,
    organizationId: row.organizationId,
  };
}

/**
 * The address of the user a PUT/PATCH would reactivate: one this provider
 * provisioned, still a member of its Organization, and deactivated now.
 * Undefined when the update would not widen anyone's access.
 */
async function reactivatedEmail(
  db: DrizzleDB,
  provider: { providerId: string; organizationId: string },
  userId: string,
): Promise<string | undefined> {
  const [row] = await db
    .select({ email: userTable.email, banned: userTable.banned })
    .from(userTable)
    .innerJoin(
      account,
      and(
        eq(account.userId, userTable.id),
        eq(account.providerId, provider.providerId),
      ),
    )
    .innerJoin(
      member,
      and(
        eq(member.userId, userTable.id),
        eq(member.organizationId, provider.organizationId),
      ),
    )
    .where(eq(userTable.id, userId))
    .limit(1);
  return row?.banned ? row.email : undefined;
}

/**
 * Refuses a SCIM create or reactivation for an Organization that fails the
 * paid-feature check, in SCIM's error schema, and records it as the
 * provider's last refused add. Returns without a word for every other request.
 */
export async function refuseScimAddWithoutPaidFeatures(
  db: DrizzleDB,
  options: ScimPlanGateOptions,
  ctx: ScimRequestContext,
): Promise<void> {
  const add = scimAddOf(ctx);
  if (!add) return;
  const provider = await authenticatedProvider(db, ctx.headers);
  if (!provider) return;
  const email =
    add.kind === 'create'
      ? add.email
      : await reactivatedEmail(db, provider, add.userId);
  if (email === undefined) return;
  if (await options.paidFeatures.hasValidLicense(provider.organizationId)) {
    return;
  }

  await db
    .update(scimProvider)
    .set({ lastRefusedAddAt: new Date(), lastRefusedAddEmail: email })
    .where(eq(scimProvider.id, provider.id));
  throw new APIError(
    'FORBIDDEN',
    scimError(403, scimAddRefusalDetail(options.instanceMode)),
  );
}
