import { asc, eq } from 'drizzle-orm';
import request from 'supertest';
import type { Response } from 'supertest';
import { App } from 'supertest/types';

import type { DrizzleDB } from '../../src/db/drizzle.module';
import { licenseKey } from '../../src/enterprise/license/license.schema';
import { member } from '../../src/organizations/organizations.schema';

/**
 * `POST /organizations` past the Self-hosted one-Organization limit
 * (ADR-0059), for a suite whose subject is not that limit but needs a second
 * Organization — a neighbour to prove tenancy against, most often.
 *
 * It does what an operator does: gives the Instance organization a valid
 * Enterprise license for the length of the request, and takes it back
 * afterwards, so nothing else the suite asks of a license (SSO, branding, the
 * build pools) sees one it did not set up itself. A license the suite already
 * gave the Instance organization is left exactly as it was. The route itself
 * runs for real — its role check, its audit row and its answer — and the
 * answer is returned as `request(...).post(...)` would return it.
 *
 * On the Hosted instance the license row is never read, so this is the plain
 * request there in all but name.
 */
export async function createOrganization(
  server: App,
  db: DrizzleDB,
  cookie: string,
  body: { name: string; [field: string]: unknown },
): Promise<Response> {
  const post = () =>
    request(server).post('/organizations').set('Cookie', cookie).send(body);

  const [instance] = await db
    .select({ organizationId: member.organizationId })
    .from(member)
    .where(eq(member.role, 'owner'))
    .orderBy(asc(member.createdAt), asc(member.id))
    .limit(1);
  if (!instance) return post();

  const [held] = await db
    .select()
    .from(licenseKey)
    .where(eq(licenseKey.organizationId, instance.organizationId))
    .limit(1);
  if (
    held?.enableEnterpriseFeatures &&
    held.key &&
    held.status === 'active' &&
    (!held.validUntil || held.validUntil.getTime() > Date.now())
  ) {
    return post();
  }
  const valid = {
    key: 'test-license-key',
    status: 'active' as const,
    enableEnterpriseFeatures: true,
    validUntil: null,
  };
  if (held) {
    await db.update(licenseKey).set(valid).where(eq(licenseKey.id, held.id));
  } else {
    await db
      .insert(licenseKey)
      .values({ organizationId: instance.organizationId, ...valid });
  }
  try {
    return await post();
  } finally {
    if (held) {
      await db
        .update(licenseKey)
        .set({
          key: held.key,
          status: held.status,
          enableEnterpriseFeatures: held.enableEnterpriseFeatures,
          validUntil: held.validUntil,
        })
        .where(eq(licenseKey.id, held.id));
    } else {
      await db
        .delete(licenseKey)
        .where(eq(licenseKey.organizationId, instance.organizationId));
    }
  }
}

export interface MemberFixture {
  /** The member's session cookie. */
  cookie: string;
  /** The `user.id` better-auth minted. */
  id: string;
  /** The invitation that was accepted, for a test that asserts on it. */
  invitationId: string;
}

export interface SignUpMemberOptions {
  /** Defaults to `'member@example.com'`. */
  email?: string;
  /** Defaults to `'Ida Rhodes'`. */
  name?: string;
  /** Defaults to `'super-secret-password'`. */
  password?: string;
  /** The organization role the invitation carries. Defaults to `'member'`. */
  role?: 'member' | 'admin';
}

/**
 * Invite, sign up and *accept* — a Member who really is one.
 *
 * The accept is the whole point of this file. Signing up with the invitation
 * token alone validates the token and stops there: `assertSignUpAllowed`
 * returns, `bootstrapDefaultOrganization` no-ops once an owner exists, and no
 * `member` row is written. Membership lands on
 * `POST /organizations/invitations/:id/accept`. A fixture that stops at the
 * sign-up therefore hands back a session with no `activeOrganizationId`, so
 * every refusal a test then asserts comes from the controller's own `toCtx`
 * — `'No active organization'`, thrown from 53 files in `src/` — rather than
 * from the role check the test claims to be about. Seven admin-gating
 * assertions in `test/settings/settings.e2e-spec.ts` were unable to fail that
 * way, and `test/admin/admin.e2e-spec.ts`'s was still unable to fail
 * when an earlier cleanup collected the remaining hand-rolled copies here.
 *
 * Because the 403s are indistinguishable by status, a caller asserting a role
 * refusal must assert the *message* — each module's
 * `'Only owners and admins can manage …'` sentence occurs exactly once in
 * `src/`, so asserting it proves the role check ran.
 *
 * **It does not seed an Organization, and that is deliberate.** The owner's
 * Organization already exists — `bootstrapDefaultOrganization` created it in
 * the owner's own sign-up hook, so `ownerCookie` already carries an
 * `activeOrganizationId`, and an invitation is issued into the inviter's
 * *active* Organization. There is no Organization for this fixture to choose.
 * Creating one was rejected: it would mean `POST /organizations`, which gates
 * on the caller's instance role, and would make one fixture do two jobs.
 *
 * A test that deliberately wants the *unaccepted* state — the accept-invitation
 * page's own subject, `test/organizations/organizations.e2e-spec.ts`'s
 * `inviteAndSignUp` — must not use this; that is what it is asserting on.
 */
export async function signUpMember(
  httpServer: App,
  ownerCookie: string,
  options: SignUpMemberOptions = {},
): Promise<MemberFixture> {
  const {
    email = 'member@example.com',
    name = 'Ida Rhodes',
    password = 'super-secret-password',
    role = 'member',
  } = options;

  const invite = await request(httpServer)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email, role });
  expect(invite.status).toBe(201);
  const invitationId = (invite.body as { id: string }).id;

  const res = await request(httpServer)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', invitationId)
    .send({ name, email, password });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie'];

  const accepted = await request(httpServer)
    .post(`/organizations/invitations/${invitationId}/accept`)
    .set('Cookie', cookie);
  expect(accepted.status).toBe(201);

  const { user } = res.body as { user: { id: string } };
  return { cookie, id: user.id, invitationId };
}

/** {@link secondOrganizationOwner}'s return: Mallory, and the Organization she owns. */
export interface SecondOrganizationOwnerFixture {
  /** Mallory's session cookie, active in her own Organization. */
  cookie: string;
  /** The `user.id` better-auth minted. */
  id: string;
  /** The second Organization, which is not the instance organization. */
  organizationId: string;
  /** The instance organization, restored as the inviter's active one. */
  instanceOrganizationId: string;
}

export interface SecondOrganizationOwnerOptions {
  /** Defaults to `'mallory@example.com'`. */
  email?: string;
  /** Defaults to `'Mallory'`. */
  name?: string;
  /** Defaults to `'Second Org'`. */
  organizationName?: string;
}

/**
 * An owner of a **second** Organization who is not a Member of the first — the
 * caller `PermissionService.checkInstanceAuthority` exists to refuse, and the
 * one every suite over the platform host was missing (ADR-0013). Every
 * neighbouring suite had already denied a plain Member; nobody had asked what
 * another organization's *owner* could do, because there was no such account to
 * ask with.
 *
 * Promoted out of `test/settings/settings.e2e-spec.ts`, where H-51/H-52 first
 * needed it, because four suites now ask that question of four different
 * platform-host surfaces — a hand-rolled copy per suite is how the five
 * `findOwnedServer`s drifted apart, and the copy that never got written
 * was the security bug. It sits beside {@link signUpMember} for the reason the cleanup
 * collected the copies of *that* here.
 *
 * The invitation is issued while the instance owner is **acting in the second
 * organization**, which is what keeps Mallory out of the first: an invitation
 * lands in the inviter's active Organization, and an admin of the instance
 * organization would pass the gate legitimately and prove nothing. `role:
 * 'owner'` is written straight to the row afterwards because `updateMemberRole`
 * refuses to hand the owner role out at all ("The owner role is
 * nontransferable") — which is one of the reasons the instance organization's
 * owner row is a safe thing to gate on in the first place.
 *
 * A second `/api/auth/sign-up/email` is not an option: sign-up closes once the
 * instance has an owner (`hasInstanceOwner`), so it answers 400 and the
 * invitation flow is the only way to a second account.
 *
 * The `member.createdAt` ordering `checkInstanceAuthority` reads is what makes
 * this fixture an attacker rather than an authority: the owner row this writes
 * is the *later* one, so the instance organization is still the first
 * organization, which is the property the whole check rests on.
 *
 * The inviter is put back in their own Organization before this returns, so a
 * test that goes on to use `ownerCookie` never depends on which Organization
 * was activated last.
 */
export async function secondOrganizationOwner(
  httpServer: App,
  db: DrizzleDB,
  ownerCookie: string,
  options: SecondOrganizationOwnerOptions = {},
): Promise<SecondOrganizationOwnerFixture> {
  const {
    email = 'mallory@example.com',
    name = 'Mallory',
    organizationName = 'Second Org',
  } = options;

  const home = await request(httpServer)
    .get('/organizations/active')
    .set('Cookie', ownerCookie);
  expect(home.status).toBe(200);
  const instanceOrganizationId = (home.body as { id: string }).id;

  const created = await createOrganization(httpServer, db, ownerCookie, {
    name: organizationName,
  });
  expect(created.status).toBe(201);
  const organizationId = (created.body as { id: string }).id;

  const activated = await request(httpServer)
    .post('/api/auth/organization/set-active')
    .set('Cookie', ownerCookie)
    .send({ organizationId });
  expect(activated.status).toBe(200);

  const mallory = await signUpMember(httpServer, ownerCookie, {
    email,
    name,
    role: 'admin',
  });
  await db
    .update(member)
    .set({ role: 'owner' })
    .where(eq(member.userId, mallory.id));

  const restored = await request(httpServer)
    .post('/api/auth/organization/set-active')
    .set('Cookie', ownerCookie)
    .send({ organizationId: instanceOrganizationId });
  expect(restored.status).toBe(200);

  return {
    cookie: mallory.cookie,
    id: mallory.id,
    organizationId,
    instanceOrganizationId,
  };
}
