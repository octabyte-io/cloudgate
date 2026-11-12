import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import type { Auth } from '../../src/auth/auth.config';
import { AUTH } from '../../src/auth/auth.constants';
import {
  invitation,
  licenseKey,
  member,
  organizationRole,
  team,
  user,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { routedAuthEndpoints } from '../utils/auth-endpoints';
import {
  createOrganization,
  secondOrganizationOwner,
  signUpMember,
} from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

interface OrgListItem {
  id: string;
  name: string;
  slug: string | null;
  ownerId: string;
  member: { role: string; isDefault: boolean };
}

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/**
 * Invites `person`, signs them up against the invitation token and accepts.
 * Accepting is what creates the membership — without it every
 * organization-scoped route refuses them for having no active organization,
 * which would mask any role check under test.
 */
async function inviteAndJoin(
  server: App,
  ownerCookie: string,
  person: { name: string; email: string; role: string },
): Promise<{ cookie: string; id: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email: person.email, role: person.role });
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({
      name: person.name,
      email: person.email,
      password: 'super-secret-password',
    });
  expect(su.status).toBe(200);
  const cookie = su.headers['set-cookie'];

  const accept = await request(server)
    .post(`/organizations/invitations/${inviteId}/accept`)
    .set('Cookie', cookie);
  expect(accept.status).toBe(201);

  return { cookie, id: (su.body as { user: { id: string } }).user.id };
}

/**
 * Invites `person` and signs them up against the invitation, stopping short of
 * accepting — the state the /accept-invitation page is read in.
 */
async function inviteAndSignUp(
  server: App,
  ownerCookie: string,
  person: { name: string; email: string; role: string },
): Promise<{ cookie: string; id: string; inviteId: string }> {
  const invite = await request(server)
    .post('/organizations/invitations')
    .set('Cookie', ownerCookie)
    .send({ email: person.email, role: person.role });
  expect(invite.status).toBe(201);
  const inviteId = (invite.body as { id: string }).id;

  const su = await request(server)
    .post('/api/auth/sign-up/email')
    .set('x-cloudgate-token', inviteId)
    .send({
      name: person.name,
      email: person.email,
      password: 'super-secret-password',
    });
  expect(su.status).toBe(200);

  return {
    cookie: su.headers['set-cookie'],
    id: (su.body as { user: { id: string } }).user.id,
    inviteId,
  };
}

/** Owner org plus one accepted member (role 'member') — the recurring fixture. */
async function setUpOrgWithMember(server: App) {
  const ownerSession = await signUp(server, owner);
  const invitee = await inviteAndJoin(server, ownerSession.cookie, {
    name: 'Ida Rhodes',
    email: 'invitee@example.com',
    role: 'member',
  });

  return { owner: ownerSession, invitee };
}

async function activeOrganizationId(
  server: App,
  cookie: string,
): Promise<string> {
  const res = await request(server)
    .get('/organizations/active')
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return (res.body as { id: string }).id;
}

/** The member row id of `userId` in the caller's active organization. */
async function memberIdOf(
  server: App,
  cookie: string,
  userId: string,
): Promise<string> {
  const res = await request(server)
    .get('/organizations/members')
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  const { members } = res.body as { members: { id: string; userId: string }[] };
  return members.find((row) => row.userId === userId)!.id;
}

/** Creates a team in the caller's active organization and returns its id. */
async function createTeam(
  server: App,
  cookie: string,
  name: string,
): Promise<string> {
  const created = await request(server)
    .post('/organizations/teams')
    .set('Cookie', cookie)
    .send({ name });
  expect(created.status).toBe(201);
  return (created.body as { id: string }).id;
}

async function teamMemberIds(
  server: App,
  cookie: string,
  teamId: string,
): Promise<string[]> {
  const list = await request(server)
    .get(`/organizations/teams/${teamId}/members`)
    .set('Cookie', cookie);
  expect(list.status).toBe(200);
  return (list.body as { userId: string }[]).map((row) => row.userId);
}

/**
 * An api key for the signed-in caller. Hoisted out of the `describe` that
 * introduced it because the team block asserts the same thing about
 * six more routes and needs the same credential.
 */
async function mintKey(server: App, cookie: string): Promise<string> {
  const created = await request(server)
    .post('/users/me/api-keys')
    .set('Cookie', cookie)
    .send({ name: 'ci-key' });
  expect(created.status).toBe(201);
  return (created.body as { key: string }).key;
}

/** The caller's permission ctx, for creating fixtures through the services. */
const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

describe('Organizations (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let applications: ApplicationsService;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    applications = ctx.app.get(ApplicationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  describe('owner bootstrap', () => {
    it('first sign-up creates a default organization with the user as owner', async () => {
      const { cookie, id } = await signUp(server, owner);

      const res = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      const orgs = res.body as OrgListItem[];
      expect(orgs).toHaveLength(1);
      expect(orgs[0]).toMatchObject({
        name: 'My Organization',
        ownerId: id,
      });
      expect(orgs[0].member).toMatchObject({ role: 'owner', isDefault: true });
    });

    it('rejects a second sign-up when an owner already exists (single-owner rule)', async () => {
      await signUp(server, owner);

      const res = await request(server).post('/api/auth/sign-up/email').send({
        name: 'Mallory',
        email: 'mallory@example.com',
        password: 'super-secret-password',
      });

      expect(res.status).toBe(400);
    });
  });

  describe('active organization', () => {
    it('resolves the default organization into the session context', async () => {
      const { cookie } = await signUp(server, owner);

      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const orgId = (orgs.body as OrgListItem[])[0].id;

      const session = await request(server)
        .get('/api/auth/get-session')
        .set('Cookie', cookie);
      expect(session.status).toBe(200);
      const body = session.body as {
        session: { activeOrganizationId: string | null };
      };
      expect(body.session.activeOrganizationId).toBe(orgId);
    });

    it('GET /organizations/active returns the active organization', async () => {
      const { cookie, id } = await signUp(server, owner);

      const res = await request(server)
        .get('/organizations/active')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'My Organization',
        ownerId: id,
      });
    });
  });

  describe('invitations', () => {
    it('owner can invite a member and the invitation is retrievable', async () => {
      const { cookie } = await signUp(server, owner);

      const created = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', cookie)
        .send({ email: 'invitee@example.com', role: 'member' });

      expect(created.status).toBe(201);
      const invite = created.body as { id: string; status: string };
      expect(invite).toMatchObject({
        email: 'invitee@example.com',
        role: 'member',
        status: 'pending',
      });

      const list = await request(server)
        .get('/organizations/invitations')
        .set('Cookie', cookie);
      expect(list.status).toBe(200);
      const invitations = list.body as { id: string }[];
      expect(invitations).toHaveLength(1);
      expect(invitations[0].id).toBe(invite.id);
    });

    it('an invited user signs up with the token and accepting joins them with the assigned role', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);

      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email: 'invitee@example.com', role: 'admin' });
      const inviteId = (invite.body as { id: string }).id;

      const signUpRes = await request(server)
        .post('/api/auth/sign-up/email')
        .set('x-cloudgate-token', inviteId)
        .send({
          name: 'Ida Rhodes',
          email: 'invitee@example.com',
          password: 'super-secret-password',
        });
      expect(signUpRes.status).toBe(200);
      const inviteeCookie = signUpRes.headers['set-cookie'];

      const accept = await request(server)
        .post(`/organizations/invitations/${inviteId}/accept`)
        .set('Cookie', inviteeCookie);
      expect(accept.status).toBe(201);

      // The invitee belongs to the inviter's org only — no bootstrapped own org.
      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', inviteeCookie);
      const list = orgs.body as OrgListItem[];
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('My Organization');
      expect(list[0].member).toMatchObject({ role: 'admin' });
    });

    /**
     * a custom role could not be given at invitation, so the only
     * way onto one was to join as `member` and be moved afterwards — holding
     * the full built-in grant in between. The invitation now carries the
     * custom role itself, so accepting it creates the membership on that role
     * and there is no `member` row to observe at any point.
     */
    describe('as a custom role', () => {
      /** A licensed owner with a `read-only` custom role defined. */
      async function licensedOwnerWithCustomRole() {
        const session = await signUp(server, owner);
        const organizationId = await activeOrganizationId(
          server,
          session.cookie,
        );
        await ctx.db.insert(organizationRole).values({
          organizationId,
          role: 'read-only',
          permission: { certificate: ['read'] },
        });
        await ctx.db.insert(licenseKey).values({
          organizationId,
          key: 'test-license-key',
          status: 'active',
          enableEnterpriseFeatures: true,
        });
        return { ...session, organizationId };
      }

      it('lands the invitee on the custom role directly, with no member state in between', async () => {
        const ownerSession = await licensedOwnerWithCustomRole();

        const created = await request(server)
          .post('/organizations/invitations')
          .set('Cookie', ownerSession.cookie)
          .send({ email: 'invitee@example.com', role: 'read-only' });
        expect(created.status).toBe(201);
        const inviteId = (created.body as { id: string; role: string }).id;
        expect((created.body as { role: string }).role).toBe('read-only');

        // The row the invitee accepts is already the custom role — not a
        // `member` invitation corrected afterwards.
        const [stored] = await ctx.db
          .select({ role: invitation.role })
          .from(invitation)
          .where(eq(invitation.id, inviteId));
        expect(stored.role).toBe('read-only');

        const su = await request(server)
          .post('/api/auth/sign-up/email')
          .set('x-cloudgate-token', inviteId)
          .send({
            name: 'Ida Rhodes',
            email: 'invitee@example.com',
            password: 'super-secret-password',
          });
        expect(su.status).toBe(200);
        const inviteeId = (su.body as { user: { id: string } }).user.id;

        const accept = await request(server)
          .post(`/organizations/invitations/${inviteId}/accept`)
          .set('Cookie', su.headers['set-cookie']);
        expect(accept.status).toBe(201);
        // The membership accepting creates is the custom role from its first
        // write: the accept answer is the row as inserted.
        expect((accept.body as { member: { role: string } }).member.role).toBe(
          'read-only',
        );

        const rows = await ctx.db
          .select({ role: member.role })
          .from(member)
          .where(eq(member.userId, inviteeId));
        expect(rows).toEqual([{ role: 'read-only' }]);
      });

      it('refuses a role this Organization has not defined, creating nothing', async () => {
        const ownerSession = await licensedOwnerWithCustomRole();

        const res = await request(server)
          .post('/organizations/invitations')
          .set('Cookie', ownerSession.cookie)
          .send({ email: 'invitee@example.com', role: 'auditor' });

        expect(res.status).toBe(404);
        expect((res.body as { message: string }).message).toContain(
          'Custom role "auditor" not found',
        );
        expect(await ctx.db.select().from(invitation)).toHaveLength(0);
      });

      it("refuses another Organization's custom role", async () => {
        const ownerSession = await licensedOwnerWithCustomRole();
        const other = await createOrganization(
          server,
          ctx.db,
          ownerSession.cookie,
          { name: 'Elsewhere' },
        );
        expect(other.status).toBe(201);
        await ctx.db.insert(organizationRole).values({
          organizationId: (other.body as { id: string }).id,
          role: 'elsewhere-only',
          permission: { certificate: ['read'] },
        });

        const res = await request(server)
          .post('/organizations/invitations')
          .set('Cookie', ownerSession.cookie)
          .send({ email: 'invitee@example.com', role: 'elsewhere-only' });

        expect(res.status).toBe(404);
        expect(await ctx.db.select().from(invitation)).toHaveLength(0);
      });

      it('refuses a custom role while the Organization has no enterprise license, creating nothing', async () => {
        const ownerSession = await signUp(server, owner);
        const organizationId = await activeOrganizationId(
          server,
          ownerSession.cookie,
        );
        await ctx.db.insert(organizationRole).values({
          organizationId,
          role: 'read-only',
          permission: { certificate: ['read'] },
        });

        const res = await request(server)
          .post('/organizations/invitations')
          .set('Cookie', ownerSession.cookie)
          .send({ email: 'invitee@example.com', role: 'read-only' });

        expect(res.status).toBe(403);
        expect((res.body as { message: string }).message).toContain(
          'valid enterprise license',
        );
        expect(await ctx.db.select().from(invitation)).toHaveLength(0);
      });

      it('still refuses owner', async () => {
        const ownerSession = await licensedOwnerWithCustomRole();

        const res = await request(server)
          .post('/organizations/invitations')
          .set('Cookie', ownerSession.cookie)
          .send({ email: 'invitee@example.com', role: 'owner' });

        expect(res.status).toBe(400);
        expect(await ctx.db.select().from(invitation)).toHaveLength(0);
      });
    });

    it('rejects an invited sign-up whose email does not match the invitation', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);

      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      const inviteId = (invite.body as { id: string }).id;

      const res = await request(server)
        .post('/api/auth/sign-up/email')
        .set('x-cloudgate-token', inviteId)
        .send({
          name: 'Mallory',
          email: 'mallory@example.com',
          password: 'super-secret-password',
        });

      expect(res.status).toBe(400);
    });

    it('a removed invitation can no longer be used to sign up', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);

      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      const inviteId = (invite.body as { id: string }).id;

      const del = await request(server)
        .delete(`/organizations/invitations/${inviteId}`)
        .set('Cookie', ownerCookie);
      expect(del.status).toBe(200);

      const list = await request(server)
        .get('/organizations/invitations')
        .set('Cookie', ownerCookie);
      expect(list.body as unknown[]).toHaveLength(0);

      const res = await request(server)
        .post('/api/auth/sign-up/email')
        .set('x-cloudgate-token', inviteId)
        .send({
          name: 'Ida Rhodes',
          email: 'invitee@example.com',
          password: 'super-secret-password',
        });
      expect(res.status).toBe(400);
    });
  });

  describe('invitation state', () => {
    it('reads an expired invitation as expired rather than as missing', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);
      const invitee = await inviteAndSignUp(server, ownerCookie, {
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        role: 'member',
      });
      // Only the clock separates a pending invitation from an expired one, and
      // the test cannot wait out better-auth's expiry window.
      await ctx.db
        .update(invitation)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(invitation.id, invitee.inviteId));

      const res = await request(server)
        .get(`/organizations/invitations/${invitee.inviteId}/state`)
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: invitee.inviteId,
        code: 'INVITATION_EXPIRED',
        status: 'pending',
      });
      expect((res.body as { expiresAt: string }).expiresAt).toBeTruthy();
    });

    it('reads an accepted invitation as already accepted, not as expired', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);
      const invitee = await inviteAndSignUp(server, ownerCookie, {
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        role: 'member',
      });
      const accept = await request(server)
        .post(`/organizations/invitations/${invitee.inviteId}/accept`)
        .set('Cookie', invitee.cookie);
      expect(accept.status).toBe(201);
      // Accepted and expired at once: what became of the invitation outranks
      // the clock, or a second click after the window closes would read as
      // "expired" to somebody who is already a member.
      await ctx.db
        .update(invitation)
        .set({ expiresAt: new Date(Date.now() - 60_000) })
        .where(eq(invitation.id, invitee.inviteId));

      const res = await request(server)
        .get(`/organizations/invitations/${invitee.inviteId}/state`)
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: invitee.inviteId,
        code: 'INVITATION_ALREADY_ACCEPTED',
        status: 'accepted',
      });
    });

    it('reads a withdrawn invitation as not found, with no status to report', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);
      const invitee = await inviteAndSignUp(server, ownerCookie, {
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        role: 'member',
      });
      const withdrawn = await request(server)
        .delete(`/organizations/invitations/${invitee.inviteId}`)
        .set('Cookie', ownerCookie);
      expect(withdrawn.status).toBe(200);

      const res = await request(server)
        .get(`/organizations/invitations/${invitee.inviteId}/state`)
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        id: invitee.inviteId,
        code: 'INVITATION_NOT_FOUND',
        status: null,
        expiresAt: null,
      });
    });

    it('tells a declined invitation apart from one the organization cancelled', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);
      const declined = await inviteAndSignUp(server, ownerCookie, {
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        role: 'member',
      });
      const reject = await request(server)
        .post('/api/auth/organization/reject-invitation')
        .set('Cookie', declined.cookie)
        .send({ invitationId: declined.inviteId });
      expect(reject.status).toBe(200);

      const declinedState = await request(server)
        .get(`/organizations/invitations/${declined.inviteId}/state`)
        .set('Cookie', declined.cookie);
      expect(declinedState.status).toBe(200);
      expect(declinedState.body).toMatchObject({
        code: 'INVITATION_REJECTED',
        status: 'rejected',
      });

      // better-auth's cancel leaves the row behind with status 'canceled';
      // Cloudgate's DELETE /organizations/invitations/:id removes it outright,
      // which is the INVITATION_NOT_FOUND case.
      const second = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      const secondId = (second.body as { id: string }).id;
      const cancel = await request(server)
        .post('/api/auth/organization/cancel-invitation')
        .set('Cookie', ownerCookie)
        .send({ invitationId: secondId });
      expect(cancel.status).toBe(200);

      const cancelledState = await request(server)
        .get(`/organizations/invitations/${secondId}/state`)
        .set('Cookie', declined.cookie);
      expect(cancelledState.status).toBe(200);
      expect(cancelledState.body).toMatchObject({
        code: 'INVITATION_WITHDRAWN',
        status: 'canceled',
      });
    });

    it('serves an invitee who is not a member and has no active organization', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);
      const invitee = await inviteAndSignUp(server, ownerCookie, {
        name: 'Ida Rhodes',
        email: 'invitee@example.com',
        role: 'member',
      });

      // Everything else about invitations is scoped to the active
      // organization, which an invitee does not have until they accept — the
      // reason this read cannot be a filter over GET /organizations/invitations.
      const active = await request(server)
        .get('/organizations/active')
        .set('Cookie', invitee.cookie);
      expect(active.status).toBe(404);
      const list = await request(server)
        .get('/organizations/invitations')
        .set('Cookie', invitee.cookie);
      expect(list.status).toBe(404);

      const res = await request(server)
        .get(`/organizations/invitations/${invitee.inviteId}/state`)
        .set('Cookie', invitee.cookie);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: invitee.inviteId,
        code: 'INVITATION_PENDING',
        status: 'pending',
      });
    });

    it('tells nobody but the recipient, not even the owner who sent it', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);
      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      const inviteId = (invite.body as { id: string }).id;

      // The route exists to serve the person the invitation was sent to. The
      // organization's own side of it is GET /organizations/invitations.
      const res = await request(server)
        .get(`/organizations/invitations/${inviteId}/state`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(403);
      // The code as well as the sentence (H-36). This route is Cloudgate's own
      // mirror of the refusal better-auth raises on `/accept`, and it published
      // nothing but a 403 and English — which is the one thing the console is
      // not allowed to read, so the two doors to the same fact answered with two
      // different sentences on screen.
      expect(res.body).toMatchObject({
        message: 'You are not the recipient of the invitation',
        code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
      });
    });

    it('refuses an anonymous caller', async () => {
      const { cookie: ownerCookie } = await signUp(server, owner);
      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerCookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      const inviteId = (invite.body as { id: string }).id;

      const res = await request(server).get(
        `/organizations/invitations/${inviteId}/state`,
      );

      expect(res.status).toBe(401);
    });
  });

  describe('members', () => {
    it('lists the members of the active organization with their roles', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const res = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      const body = res.body as {
        members: { userId: string; role: string }[];
        total: number;
      };
      expect(body.total).toBe(2);
      const roleByUser = Object.fromEntries(
        body.members.map((m) => [m.userId, m.role]),
      );
      expect(roleByUser[ownerSession.id]).toBe('owner');
      expect(roleByUser[invitee.id]).toBe('member');
    });

    /**
     * The three `accessed*` columns are Cloudgate's, and better-auth's member
     * model declares no `additionalFields` for them — so `listMembers`, which
     * is a passthrough, answered without them while the console's own `Member`
     * contract declares all three as required. An earlier change added the write route and
     * no read, so nothing rendered them and the gap stayed invisible until
     * a console dialog seeded itself from this response and crashed on
     * `[...undefined]`.
     *
     * The crash was the lucky failure. That dialog sends **whole sets** back,
     * so an absent column read as an empty grant would have seeded every box
     * unticked and saved that — revoking, on open, every grant the Member had.
     * This asserts the columns are present and carry their values, because a
     * shape that silently loses them is a data-loss bug rather than a 500.
     */
    it('carries the accessed columns better-auth does not select', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const before = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      const inviteeMemberId = (
        before.body as { members: { id: string; userId: string }[] }
      ).members.find((m) => m.userId === invitee.id)!.id;

      // Every member arrives with all three keys, empty rather than absent —
      // absent is what `[...undefined]` threw on.
      for (const row of (
        before.body as {
          members: {
            accessedProjects: string[];
            accessedEnvironments: string[];
            accessedServices: string[];
          }[];
        }
      ).members) {
        expect(Array.isArray(row.accessedProjects)).toBe(true);
        expect(Array.isArray(row.accessedEnvironments)).toBe(true);
        expect(Array.isArray(row.accessedServices)).toBe(true);
      }

      const granted = await request(server)
        .patch(`/organizations/members/${inviteeMemberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({
          accessedProjects: [],
          accessedEnvironments: [],
          accessedServices: [],
        });
      expect(granted.status).toBe(200);

      // And the values are this member's own, read back through the list the
      // dialog seeds from rather than through the row it just wrote.
      const after = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      const row = (
        after.body as {
          members: { id: string; accessedProjects: string[] }[];
        }
      ).members.find((m) => m.id === inviteeMemberId)!;
      expect(row.accessedProjects).toEqual([]);
    });

    /**
     * better-auth joins the user onto each member with four fields — `id`,
     * `name`, `email`, `image` — and `lastName` is not one of them: it is a
     * Cloudgate column (`additionalFields`), which the plugin's join does not
     * select. So the Members table named everyone by first name alone while
     * Settings → Account promised the last name "wherever Cloudgate names
     * you". The image is asserted beside it because the console now
     * renders it, and it arriving is the plugin's behaviour, not ours.
     */
    it('carries the last name and avatar of every member', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      await ctx.db
        .update(user)
        .set({ lastName: 'Hopper-Last', image: 'https://example.com/g.png' })
        .where(eq(user.id, ownerSession.id));

      const res = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);

      expect(res.status).toBe(200);
      const members = (
        res.body as {
          members: {
            userId: string;
            user: { name: string; lastName: string; image: string | null };
          }[];
        }
      ).members;
      const owner = members.find((m) => m.userId === ownerSession.id)!;
      expect(owner.user).toMatchObject({
        name: 'Grace Hopper',
        lastName: 'Hopper-Last',
        image: 'https://example.com/g.png',
      });
      // A member who never set one reads as empty rather than absent, the
      // column's own default.
      const other = members.find((m) => m.userId === invitee.id)!;
      expect(other.user.lastName).toBe('');
    });

    /**
     * A member whose account is banned was listed exactly like an active one
     * better-auth joins four user fields and the ban is not one of
     * them, so the console had nothing to mark the row with. The route answers
     * the ban as `deactivation`, decided here by the same `banInForce` every
     * credential reader refuses on — so the console is not inferring it, and a
     * ban whose `banExpires` has passed reads as active, as it signs in.
     *
     * Only the three things the row says travel: the user's own `banned`,
     * `banReason` and `banExpires` columns do not ride along on `user`.
     */
    describe('deactivation', () => {
      type Row = {
        userId: string;
        user: Record<string, unknown>;
        deactivation: {
          byDirectory: boolean;
          reason: string | null;
          expiresAt: string | null;
        } | null;
      };
      const roster = async (cookie: string): Promise<Row[]> => {
        const res = await request(server)
          .get('/organizations/members')
          .set('Cookie', cookie);
        expect(res.status).toBe(200);
        return (res.body as { members: Row[] }).members;
      };

      it('is null for every member whose account is not banned', async () => {
        const { owner: ownerSession } = await setUpOrgWithMember(server);

        for (const row of await roster(ownerSession.cookie)) {
          expect(row.deactivation).toBeNull();
          expect(row.user).not.toHaveProperty('banned');
          expect(row.user).not.toHaveProperty('banReason');
          expect(row.user).not.toHaveProperty('banExpires');
        }
      });

      it('names the directory when the ban is the one SCIM writes', async () => {
        const { owner: ownerSession, invitee } =
          await setUpOrgWithMember(server);
        await ctx.db
          .update(user)
          .set({ banned: true, banReason: 'Deactivated via SCIM' })
          .where(eq(user.id, invitee.id));

        const rows = await roster(ownerSession.cookie);
        expect(rows.find((m) => m.userId === invitee.id)!.deactivation).toEqual(
          {
            byDirectory: true,
            reason: 'Deactivated via SCIM',
            expiresAt: null,
          },
        );
        expect(
          rows.find((m) => m.userId === ownerSession.id)!.deactivation,
        ).toBeNull();
      });

      it('carries any other ban with its reason and end, not as the directory', async () => {
        const { owner: ownerSession, invitee } =
          await setUpOrgWithMember(server);
        const until = new Date(Date.now() + 3_600_000);
        await ctx.db
          .update(user)
          .set({
            banned: true,
            banReason: 'Banned by an owner',
            banExpires: until,
          })
          .where(eq(user.id, invitee.id));

        const row = (await roster(ownerSession.cookie)).find(
          (m) => m.userId === invitee.id,
        )!;
        expect(row.deactivation).toEqual({
          byDirectory: false,
          reason: 'Banned by an owner',
          expiresAt: until.toISOString(),
        });
      });

      it('reads a ban whose end has passed as active, as signing in does', async () => {
        const { owner: ownerSession, invitee } =
          await setUpOrgWithMember(server);
        await ctx.db
          .update(user)
          .set({
            banned: true,
            banReason: 'Banned by an owner',
            banExpires: new Date(Date.now() - 60_000),
          })
          .where(eq(user.id, invitee.id));

        const row = (await roster(ownerSession.cookie)).find(
          (m) => m.userId === invitee.id,
        )!;
        expect(row.deactivation).toBeNull();
      });
    });

    it('owner can change a member role, but not their own or the owner role', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const members = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      const list = (
        members.body as { members: { id: string; userId: string }[] }
      ).members;
      const inviteeMemberId = list.find((m) => m.userId === invitee.id)!.id;
      const ownerMemberId = list.find((m) => m.userId === ownerSession.id)!.id;

      const promote = await request(server)
        .patch(`/organizations/members/${inviteeMemberId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'admin' });
      expect(promote.status).toBe(200);

      const after = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      const roleByUser = Object.fromEntries(
        (
          after.body as { members: { userId: string; role: string }[] }
        ).members.map((m) => [m.userId, m.role]),
      );
      expect(roleByUser[invitee.id]).toBe('admin');

      // Changing your own role is forbidden.
      const self = await request(server)
        .patch(`/organizations/members/${ownerMemberId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'admin' });
      expect(self.status).toBe(403);

      // The owner role is non-transferable. The role field accepts any name
      // (custom roles are names, not an enum), so this is refused by the rule
      // rather than by validation.
      const toOwner = await request(server)
        .patch(`/organizations/members/${inviteeMemberId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'owner' });
      expect(toOwner.status).toBe(403);
    });

    /**
     * assigning a custom role used to be accepted with no license
     * check, and `PermissionService.resolveRole` then resolved it to nothing —
     * the member was refused every permission-checked route rather than
     * narrowed to what the role grants. The assignment is refused instead.
     *
     * The role row is inserted directly because defining one through
     * `POST /custom-roles` is itself license-gated; this is the state an
     * Organization is left in once its license lapses, since nothing deletes
     * the `organization_role` rows.
     */
    it('refuses to assign a custom role while the organization has no enterprise license', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'read-only',
        permission: { certificate: ['read'] },
      });
      const inviteeMemberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      const res = await request(server)
        .patch(`/organizations/members/${inviteeMemberId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'read-only' });

      expect(res.status).toBe(403);
      expect((res.body as { message: string }).message).toContain(
        'valid enterprise license',
      );

      // Refused means unchanged: no half-applied role left on the member row.
      const [after] = await ctx.db
        .select({ role: member.role })
        .from(member)
        .where(eq(member.userId, invitee.id));
      expect(after.role).toBe('member');
    });

    it('assigns a custom role once the organization is licensed', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'read-only',
        permission: { certificate: ['read'] },
      });
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      const inviteeMemberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      const res = await request(server)
        .patch(`/organizations/members/${inviteeMemberId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ role: 'read-only' });

      expect(res.status).toBe(200);
      expect((res.body as { role: string }).role).toBe('read-only');
    });

    it('removing a member takes away their access to the organization', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const members = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      const inviteeMemberId = (
        members.body as { members: { id: string; userId: string }[] }
      ).members.find((m) => m.userId === invitee.id)!.id;

      const del = await request(server)
        .delete(`/organizations/members/${inviteeMemberId}`)
        .set('Cookie', ownerSession.cookie);
      expect(del.status).toBe(200);

      const after = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      expect((after.body as { total: number }).total).toBe(1);

      const inviteeOrgs = await request(server)
        .get('/organizations')
        .set('Cookie', invitee.cookie);
      expect(inviteeOrgs.body as unknown[]).toHaveLength(0);
    });
  });

  /**
   * Until this route existed, `member.accessedServices` had exactly
   * one writer — grant-on-create — and `memberRole` has no `service: create`,
   * so every Member on a real instance was a zero-service Member and the
   * row-level half of `checkServiceAccess` could only ever refuse. The VPS run
   * had to write the column by SQL to see the allowing direction at all.
   *
   * So the first test here is the one that has never been possible: a Member
   * granted a Service reaches it, and reaches no other.
   */
  describe('member entitlements', () => {
    /** Two Services in the owner's Organization, one to grant and one to withhold. */
    async function setUpTwoServices(ownerId: string, organizationId: string) {
      const ownerCtx = permissionCtx(ownerId, organizationId);
      const project = await projects.create(ownerCtx, { name: 'cloudgate' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      const granted = await applications.create(ownerCtx, {
        name: 'Granted',
        appName: 'granted-app',
        environmentId: environment.environmentId,
      });
      const withheld = await applications.create(ownerCtx, {
        name: 'Withheld',
        appName: 'withheld-app',
        environmentId: environment.environmentId,
      });
      return { project, environment, granted, withheld };
    }

    const readApplication = (cookie: string, applicationId: string) =>
      request(server)
        .get(`/applications/${applicationId}`)
        .set('Cookie', cookie);

    it('grants a member one service, and the member reaches that one and no other', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const { granted, withheld } = await setUpTwoServices(
        ownerSession.id,
        organizationId,
      );
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      // The state every member was permanently in before this route.
      expect(
        (await readApplication(invitee.cookie, granted.applicationId)).status,
      ).toBe(403);

      const patched = await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedServices: [granted.applicationId] });

      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        id: memberId,
        accessedServices: [granted.applicationId],
      });

      const reached = await readApplication(
        invitee.cookie,
        granted.applicationId,
      );
      expect(reached.status).toBe(200);
      expect(reached.body).toMatchObject({
        applicationId: granted.applicationId,
        name: 'Granted',
      });

      // The grant is per Service, not a door to the Environment it sits in.
      expect(
        (await readApplication(invitee.cookie, withheld.applicationId)).status,
      ).toBe(403);
    });

    it('clears a grant when the array arrives empty', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const { granted } = await setUpTwoServices(
        ownerSession.id,
        organizationId,
      );
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedServices: [granted.applicationId] });

      const cleared = await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedServices: [] });

      expect(cleared.status).toBe(200);
      expect(
        (cleared.body as { accessedServices: string[] }).accessedServices,
      ).toEqual([]);
      expect(
        (await readApplication(invitee.cookie, granted.applicationId)).status,
      ).toBe(403);
    });

    it('leaves a column alone when its key is absent', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const { project, granted } = await setUpTwoServices(
        ownerSession.id,
        organizationId,
      );
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedServices: [granted.applicationId] });

      const projectOnly = await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedProjects: [project.projectId] });

      expect(projectOnly.status).toBe(200);
      expect(projectOnly.body).toMatchObject({
        accessedProjects: [project.projectId],
        accessedServices: [granted.applicationId],
      });
      expect(
        (await readApplication(invitee.cookie, granted.applicationId)).status,
      ).toBe(200);
    });

    it('an empty body changes nothing and answers the member unchanged', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const { granted } = await setUpTwoServices(
        ownerSession.id,
        organizationId,
      );
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedServices: [granted.applicationId] });

      const noop = await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({});

      expect(noop.status).toBe(200);
      expect(
        (noop.body as { accessedServices: string[] }).accessedServices,
      ).toEqual([granted.applicationId]);
    });

    it('refuses a service of another organization rather than storing it', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      // A disjoint second tenant: the same owner creating a second
      // Organization, since a second sign-up is refused on this instance and an
      // invited member cannot create one.
      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Organization' },
      );
      expect(second.status).toBe(201);
      const otherOrgId = (second.body as { id: string }).id;
      const foreign = await setUpTwoServices(ownerSession.id, otherOrgId);

      const res = await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedServices: [foreign.granted.applicationId] });

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        `Service not found: ${foreign.granted.applicationId}`,
      );

      // Nothing was stored on the way to being refused.
      const [row] = await ctx.db
        .select()
        .from(member)
        .where(eq(member.id, memberId));
      expect(row.accessedServices).toEqual([]);
      expect(organizationId).not.toBe(otherOrgId);
    });

    it('refuses a member granting themselves', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      const res = await request(server)
        .patch(`/organizations/members/${memberId}/entitlements`)
        .set('Cookie', invitee.cookie)
        .send({ accessedServices: ['whatever'] });

      expect(res.status).toBe(403);
    });

    it('reads a member of another organization as absent', async () => {
      const { owner: ownerSession } = await setUpOrgWithMember(server);

      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Organization' },
      );
      const otherOrgId = (second.body as { id: string }).id;
      const [otherMember] = await ctx.db
        .select()
        .from(member)
        .where(eq(member.organizationId, otherOrgId));

      const res = await request(server)
        .patch(`/organizations/members/${otherMember.id}/entitlements`)
        .set('Cookie', ownerSession.cookie)
        .send({ accessedServices: [] });

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Member not found',
      );
    });
  });

  /**
   * F-32 and F-51. An api-key caller could create an Organization
   * and read it back, but every route that delegated to better-auth's own
   * organization plugin refused it: the plugin resolves the tenant from its own
   * session store, and Cloudgate's synthetic api-key session is not in it. The
   * refusal was a `400` saying the Organization did not exist.
   */
  describe('members and invitations under an API key', () => {
    it('invites a member into the key owner organization', async () => {
      const ownerSession = await signUp(server, owner);
      const key = await mintKey(server, ownerSession.cookie);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const res = await request(server)
        .post('/organizations/invitations')
        .set('x-api-key', key)
        .send({ email: 'invitee@example.com', role: 'member' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        email: 'invitee@example.com',
        organizationId,
      });
    });

    it('lists the members of the key owner organization', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);

      const res = await request(server)
        .get('/organizations/members')
        .set('x-api-key', key);

      expect(res.status).toBe(200);
      const body = res.body as {
        members: { userId: string }[];
        total: number;
      };
      expect(body.total).toBe(2);
      expect(body.members.map((row) => row.userId)).toContain(invitee.id);
    });

    it('removes a member, and reports an unknown member id as not found', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );

      const unknown = await request(server)
        .delete('/organizations/members/zzzz-bogus')
        .set('x-api-key', key);
      // The message is the tell: F-51's key never reached the lookup and said
      // "No active organization" where the cookie said this.
      expect((unknown.body as { message: string }).message).toBe(
        'Member not found',
      );

      const removed = await request(server)
        .delete(`/organizations/members/${memberId}`)
        .set('x-api-key', key);
      expect(removed.status).toBe(200);

      const after = await request(server)
        .get('/organizations/members')
        .set('Cookie', ownerSession.cookie);
      expect((after.body as { total: number }).total).toBe(1);
    });

    it('does not reach a member of an organization the key is not scoped to', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);

      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Organization' },
      );
      const otherOrgId = (second.body as { id: string }).id;
      const [stranger] = await ctx.db
        .insert(member)
        .values({
          organizationId: otherOrgId,
          userId: invitee.id,
          role: 'member',
          createdAt: new Date(),
        })
        .returning();

      const res = await request(server)
        .delete(`/organizations/members/${stranger.id}`)
        .set('x-api-key', key);

      expect((res.body as { message: string }).message).toBe(
        'Member not found',
      );
      const [survivor] = await ctx.db
        .select()
        .from(member)
        .where(eq(member.id, stranger.id));
      expect(survivor).toBeDefined();
    });

    /**
     * better-auth's own role write is closed. It gates on the plugin's
     * org-role check alone, so it would be a second writer of `member.role`
     * beside `OrganizationsService.updateMemberRole` — skipping the licence,
     * the owner rules and, once Agents exist, the agent-role rule. The
     * endpoint is looked up on the running instance first, so a better-auth
     * upgrade that renames it reds here rather than leaving the new path open.
     */
    it("closes better-auth's own update-member-role, to the key and the cookie", async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );
      const roleOf = async () =>
        (
          await ctx.db
            .select({ role: member.role })
            .from(member)
            .where(eq(member.id, memberId))
        )[0].role;
      const before = await roleOf();

      expect(
        routedAuthEndpoints(ctx.app).find(
          ({ name }) => name === 'updateMemberRole',
        ),
      ).toEqual({
        name: 'updateMemberRole',
        path: '/organization/update-member-role',
        methods: ['POST'],
      });

      for (const [header, value] of [
        ['x-api-key', key],
        ['Cookie', ownerSession.cookie],
      ]) {
        const res = await request(server)
          .post('/api/auth/organization/update-member-role')
          .set(header, value)
          .send({ memberId, role: 'admin', organizationId });
        expect([header, res.status]).toEqual([header, 404]);
      }
      expect(await roleOf()).toBe(before);
    });

    /**
     * Every routed better-auth write under `/organization/` is placed —
     * closed by `disabledPaths` because Cloudgate owns the write, or kept
     * open for a stated reason. A better-auth upgrade that adds or renames
     * one reds here until someone places it, and a stale `CLOSED` entry reds
     * too, because the routed set must equal the two sets together.
     */
    it('classifies every routed better-auth write under /organization/ as closed or kept open', () => {
      const CLOSED = new Set([
        '/organization/create',
        '/organization/update',
        '/organization/delete',
        '/organization/update-member-role',
        '/organization/invite-member',
        '/organization/remove-member',
        '/organization/leave',
      ]);
      const KEPT_OPEN = new Map([
        [
          '/organization/accept-invitation',
          'the console accepts through it; every invitation comes from Cloudgate',
        ],
        [
          '/organization/reject-invitation',
          'writes only an invitation status, for an invitation Cloudgate made',
        ],
        [
          '/organization/cancel-invitation',
          "invitation status only, behind the same owner/admin gate as Cloudgate's",
        ],
        ['/organization/set-active', 'session only; the console calls it'],
        ['/organization/set-active-team', 'session only'],
        ['/organization/check-slug', 'a read'],
        [
          '/organization/has-permission',
          "a read: asks the plugin's role check, writes nothing",
        ],
        [
          '/organization/create-team',
          'team tables only; Cloudgate delegates the same body',
        ],
        [
          '/organization/update-team',
          'team tables only; Cloudgate delegates the same body',
        ],
        [
          '/organization/remove-team',
          'team tables only; Cloudgate delegates the same body',
        ],
        [
          '/organization/add-team-member',
          'team tables only; Cloudgate delegates the same body',
        ],
        [
          '/organization/remove-team-member',
          'team tables only; Cloudgate delegates the same body',
        ],
      ]);

      const routed = routedAuthEndpoints(ctx.app)
        .filter(
          ({ path, methods }) =>
            path.startsWith('/organization/') && methods.includes('POST'),
        )
        .map(({ path }) => path)
        .sort();
      expect(routed).toEqual([...CLOSED, ...KEPT_OPEN.keys()].sort());
      expect([...CLOSED].filter((path) => KEPT_OPEN.has(path))).toEqual([]);
      const disabled = new Set(
        ctx.app.get<Auth>(AUTH).options.disabledPaths ?? [],
      );
      expect([...CLOSED].filter((path) => !disabled.has(path))).toEqual([]);
      expect(
        [...KEPT_OPEN.keys()].filter((path) => disabled.has(path)),
      ).toEqual([]);
    });

    /**
     * better-auth's other writes of `member` are closed. Its
     * invite-member lets an owner invite `owner` — a second owner once
     * accepted — and skips every rule and the audit row of
     * `POST /organizations/invitations`; remove-member and leave write no
     * audit row. Cloudgate's own routes still reach the same `auth.api`
     * calls in-process.
     */
    it("closes better-auth's own invite-member, remove-member and leave, to the key and the cookie", async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const memberId = await memberIdOf(
        server,
        ownerSession.cookie,
        invitee.id,
      );
      const inviteeKey = await mintKey(server, invitee.cookie);
      const memberRow = async () =>
        ctx.db.select().from(member).where(eq(member.id, memberId));
      const invitationsTo = async (email: string) =>
        ctx.db.select().from(invitation).where(eq(invitation.email, email));

      for (const [header, ownerValue, inviteeValue] of [
        ['x-api-key', key, inviteeKey],
        ['Cookie', ownerSession.cookie, invitee.cookie],
      ]) {
        const invite = await request(server)
          .post('/api/auth/organization/invite-member')
          .set(header, ownerValue)
          .send({
            email: 'second-owner@example.com',
            role: 'owner',
            organizationId,
          });
        expect([header, 'invite-member', invite.status]).toEqual([
          header,
          'invite-member',
          404,
        ]);

        const remove = await request(server)
          .post('/api/auth/organization/remove-member')
          .set(header, ownerValue)
          .send({ memberIdOrEmail: memberId, organizationId });
        expect([header, 'remove-member', remove.status]).toEqual([
          header,
          'remove-member',
          404,
        ]);

        const leave = await request(server)
          .post('/api/auth/organization/leave')
          .set(header, inviteeValue)
          .send({ organizationId });
        expect([header, 'leave', leave.status]).toEqual([header, 'leave', 404]);
      }
      expect(await invitationsTo('second-owner@example.com')).toEqual([]);
      expect(await memberRow()).toHaveLength(1);

      // The baseline: Cloudgate's own doors to the same writes still work.
      const invited = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerSession.cookie)
        .send({ email: 'next@example.com', role: 'member' });
      expect(invited.status).toBe(201);
      expect(await invitationsTo('next@example.com')).toHaveLength(1);

      const removed = await request(server)
        .delete(`/organizations/members/${memberId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      expect(await memberRow()).toEqual([]);
    });
  });

  /**
   * The same defect, on the six team routes it deliberately
   * left alone for being unexercised: each handed better-auth nothing
   * tenant-shaped, so `crud-team.mjs` fell through to the active organization
   * of a better-auth session the api-key caller does not have and answered
   * `400 "No active organization"`.
   *
   * Every case asserts the success status **and** the body, not merely that the
   * status is not 400 — against the unfixed service each of the six returns
   * that 400, so a weaker assertion would pass on the bug.
   */
  describe('teams under an API key', () => {
    it('creates a team in the key owner organization', async () => {
      const ownerSession = await signUp(server, owner);
      const key = await mintKey(server, ownerSession.cookie);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );

      const res = await request(server)
        .post('/organizations/teams')
        .set('x-api-key', key)
        .send({ name: 'Platform' });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ name: 'Platform', organizationId });
    });

    it('lists the teams of the key owner organization', async () => {
      const ownerSession = await signUp(server, owner);
      const key = await mintKey(server, ownerSession.cookie);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');

      const res = await request(server)
        .get('/organizations/teams')
        .set('x-api-key', key);

      expect(res.status).toBe(200);
      const teams = res.body as { id: string; name: string }[];
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({
        id: teamId,
        name: 'Platform',
        organizationId,
      });
    });

    it('renames a team of the key owner organization, leaving the rest of the row alone', async () => {
      const ownerSession = await signUp(server, owner);
      const key = await mintKey(server, ownerSession.cookie);
      const organizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');

      const res = await request(server)
        .patch(`/organizations/teams/${teamId}`)
        .set('x-api-key', key)
        .send({ name: 'Infra' });

      expect(res.status).toBe(200);
      // The id and the tenant are asserted, not just the name: this is the one
      // route whose organization id travels inside `data` beside `name`, and
      // better-auth spreads onto the row whatever it did not destructure back
      // out — so a wrongly-shaped `data` shows up here as a mangled row.
      expect(res.body).toMatchObject({
        id: teamId,
        name: 'Infra',
        organizationId,
      });
    });

    it('deletes a team of the key owner organization', async () => {
      const ownerSession = await signUp(server, owner);
      const key = await mintKey(server, ownerSession.cookie);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');

      const res = await request(server)
        .delete(`/organizations/teams/${teamId}`)
        .set('x-api-key', key);

      expect(res.status).toBe(200);
      const after = await request(server)
        .get('/organizations/teams')
        .set('Cookie', ownerSession.cookie);
      expect(after.body as unknown[]).toHaveLength(0);
    });

    it('adds a member to a team of the key owner organization', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');

      const res = await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('x-api-key', key)
        .send({ userId: invitee.id });

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ teamId, userId: invitee.id });
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual([
        invitee.id,
      ]);
    });

    it('takes a member off a team of the key owner organization', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');
      await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie)
        .send({ userId: invitee.id });

      const res = await request(server)
        .delete(`/organizations/teams/${teamId}/members/${invitee.id}`)
        .set('x-api-key', key);

      expect(res.status).toBe(200);
      expect((res.body as { message: string }).message).toBe(
        'Team member removed successfully.',
      );
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual(
        [],
      );
    });

    /**
     * The case that proves the explicit id narrowed rather than widened. It
     * fails loudly the day the organization id is sourced from the request
     * instead of from the resolved session.
     */
    it('does not reach a team of an organization the key is not scoped to', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const key = await mintKey(server, ownerSession.cookie);

      const second = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Organization' },
      );
      const otherOrgId = (second.body as { id: string }).id;
      const [stranger] = await ctx.db
        .insert(team)
        .values({
          organizationId: otherOrgId,
          name: 'Their Platform',
          createdAt: new Date(),
        })
        .returning();

      const renamed = await request(server)
        .patch(`/organizations/teams/${stranger.id}`)
        .set('x-api-key', key)
        .send({ name: 'Mine now' });
      expect(renamed.status).toBe(400);
      expect((renamed.body as { message: string }).message).toBe(
        'Team not found',
      );

      const added = await request(server)
        .post(`/organizations/teams/${stranger.id}/members`)
        .set('x-api-key', key)
        .send({ userId: invitee.id });
      expect(added.status).toBe(400);
      expect((added.body as { message: string }).message).toBe(
        'Team not found',
      );

      const deleted = await request(server)
        .delete(`/organizations/teams/${stranger.id}`)
        .set('x-api-key', key);
      expect(deleted.status).toBe(400);
      expect((deleted.body as { message: string }).message).toBe(
        'Team not found',
      );

      const [survivor] = await ctx.db
        .select()
        .from(team)
        .where(eq(team.id, stranger.id));
      expect(survivor.name).toBe('Their Platform');
      // The key's own Organization is what it can still see, and the stranger
      // team is not in it.
      const mine = await request(server)
        .get('/organizations/teams')
        .set('x-api-key', key);
      expect(mine.body as unknown[]).toHaveLength(0);
    });
  });

  describe('teams', () => {
    it('creates and lists teams in the active organization', async () => {
      const { cookie } = await signUp(server, owner);

      const created = await request(server)
        .post('/organizations/teams')
        .set('Cookie', cookie)
        .send({ name: 'Platform' });

      expect(created.status).toBe(201);
      const team = created.body as { id: string; name: string };
      expect(team.name).toBe('Platform');

      const list = await request(server)
        .get('/organizations/teams')
        .set('Cookie', cookie);
      expect(list.status).toBe(200);
      const teams = list.body as { id: string; name: string }[];
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({ id: team.id, name: 'Platform' });
    });

    it('assigns a member to a team and lists team members', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const created = await request(server)
        .post('/organizations/teams')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Platform' });
      const teamId = (created.body as { id: string }).id;

      const add = await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie)
        .send({ userId: invitee.id });
      expect(add.status).toBe(201);

      const list = await request(server)
        .get(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie);
      expect(list.status).toBe(200);
      const teamMembers = list.body as { userId: string }[];
      expect(teamMembers).toHaveLength(1);
      expect(teamMembers[0].userId).toBe(invitee.id);
    });

    it('renames and deletes a team', async () => {
      const { cookie } = await signUp(server, owner);

      const created = await request(server)
        .post('/organizations/teams')
        .set('Cookie', cookie)
        .send({ name: 'Platform' });
      const teamId = (created.body as { id: string }).id;

      const rename = await request(server)
        .patch(`/organizations/teams/${teamId}`)
        .set('Cookie', cookie)
        .send({ name: 'Infra' });
      expect(rename.status).toBe(200);

      const afterRename = await request(server)
        .get('/organizations/teams')
        .set('Cookie', cookie);
      expect((afterRename.body as { id: string; name: string }[])[0].name).toBe(
        'Infra',
      );

      const del = await request(server)
        .delete(`/organizations/teams/${teamId}`)
        .set('Cookie', cookie);
      expect(del.status).toBe(200);

      const afterDelete = await request(server)
        .get('/organizations/teams')
        .set('Cookie', cookie);
      expect(afterDelete.body as unknown[]).toHaveLength(0);
    });
  });

  describe('team members', () => {
    it('the owner can take a member off a team, leaving the team and the membership intact', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');
      await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie)
        .send({ userId: invitee.id });
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual([
        invitee.id,
      ]);

      const removed = await request(server)
        .delete(`/organizations/teams/${teamId}/members/${invitee.id}`)
        .set('Cookie', ownerSession.cookie);

      expect(removed.status).toBe(200);
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual(
        [],
      );

      // Removing the one team member is not removing the team, nor the
      // person's membership of the organization — the whole point of the route.
      const teams = await request(server)
        .get('/organizations/teams')
        .set('Cookie', ownerSession.cookie);
      expect(teams.body as unknown[]).toHaveLength(1);
      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', invitee.cookie);
      expect(orgs.body as unknown[]).toHaveLength(1);
    });

    it('an admin can take a member off a team', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const admin = await inviteAndJoin(server, ownerSession.cookie, {
        name: 'Jean Sammet',
        email: 'admin@example.com',
        role: 'admin',
      });
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');
      await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie)
        .send({ userId: invitee.id });

      const removed = await request(server)
        .delete(`/organizations/teams/${teamId}/members/${invitee.id}`)
        .set('Cookie', admin.cookie);

      expect(removed.status).toBe(200);
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual(
        [],
      );
    });

    it('a plain member may not remove anybody from a team, including themselves', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');
      await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie)
        .send({ userId: invitee.id });

      const refused = await request(server)
        .delete(`/organizations/teams/${teamId}/members/${invitee.id}`)
        .set('Cookie', invitee.cookie);

      expect(refused.status).toBe(403);
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual([
        invitee.id,
      ]);
    });

    it('an anonymous caller may not remove a team member', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');
      await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie)
        .send({ userId: invitee.id });

      const refused = await request(server).delete(
        `/organizations/teams/${teamId}/members/${invitee.id}`,
      );

      expect(refused.status).toBe(401);
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual([
        invitee.id,
      ]);
    });

    it('removing somebody who is not on the team says so, and is not confused with success', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');

      const notOnTeam = await request(server)
        .delete(`/organizations/teams/${teamId}/members/${invitee.id}`)
        .set('Cookie', ownerSession.cookie);
      expect(notOnTeam.status).toBe(400);
      expect((notOnTeam.body as { message: string }).message).toBe(
        'User is not a member of the team',
      );

      const notInOrganization = await request(server)
        .delete(`/organizations/teams/${teamId}/members/nobody-at-all`)
        .set('Cookie', ownerSession.cookie);
      expect(notInOrganization.status).toBe(400);
      expect((notInOrganization.body as { message: string }).message).toBe(
        'User is not a member of the organization',
      );
    });

    it('reads a team of another organization as absent', async () => {
      const { owner: ownerSession } = await setUpOrgWithMember(server);
      const teamId = await createTeam(server, ownerSession.cookie, 'Platform');
      // The owner is the target here: they are a member of both organizations,
      // so the attempt gets as far as resolving the team.
      await request(server)
        .post(`/organizations/teams/${teamId}/members`)
        .set('Cookie', ownerSession.cookie)
        .send({ userId: ownerSession.id });

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const switched = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerSession.cookie)
        .send({ organizationId: (secondOrg.body as { id: string }).id });
      expect(switched.status).toBe(200);

      const refused = await request(server)
        .delete(`/organizations/teams/${teamId}/members/${ownerSession.id}`)
        .set('Cookie', ownerSession.cookie);

      // The team is scoped to the session's active organization, so from the
      // second organization it does not exist.
      expect(refused.status).toBe(400);
      expect((refused.body as { message: string }).message).toBe(
        'Team not found',
      );
      expect(await teamMemberIds(server, ownerSession.cookie, teamId)).toEqual([
        ownerSession.id,
      ]);
    });
  });

  describe('the one-Organization limit on a Self-hosted instance (ADR-0059)', () => {
    const STAFF_REFUSAL =
      'Without an Enterprise license this instance allows one Organization. Add a license under Settings > License';
    const PLAIN_REFUSAL =
      "Without an Enterprise license this instance allows one Organization. The instance's administrators can add a license";

    /** A valid Enterprise license on `organizationId`, as activating one leaves it. */
    async function license(organizationId: string, validUntil: Date | null) {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'CG-ENTERPRISE-KEY',
        status: 'active',
        enableEnterpriseFeatures: true,
        validUntil,
      });
    }

    async function create(cookie: string, name: string) {
      return request(server)
        .post('/organizations')
        .set('Cookie', cookie)
        .send({ name });
    }

    async function creation(cookie: string) {
      const res = await request(server)
        .get('/organizations/creation')
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      return res.body as {
        allowed: boolean;
        reason: string | null;
        code: string | null;
        licenseHint: boolean;
        overLimit: { count: number | null } | null;
        ownedPayingForThemselves: { count: number; of: number } | null;
        planHint: { kind: string } | null;
      };
    }

    async function organizationCount(cookie: string) {
      const res = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      return (res.body as OrgListItem[]).length;
    }

    it('lets the first Organization be made at sign-up', async () => {
      const ownerSession = await signUp(server, owner);
      expect(await organizationCount(ownerSession.cookie)).toBe(1);
    });

    it("refuses a second Organization with ORGANIZATION_LIMIT, pointing the Instance organization's owner at a license", async () => {
      const ownerSession = await signUp(server, owner);

      const refused = await create(ownerSession.cookie, 'Second Org');

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message: STAFF_REFUSAL,
      });
      expect(await organizationCount(ownerSession.cookie)).toBe(1);
    });

    it("gives the Instance organization's admins the same pointer", async () => {
      const ownerSession = await signUp(server, owner);
      const admin = await signUpMember(server, ownerSession.cookie, {
        email: 'admin@example.com',
        role: 'admin',
      });

      const refused = await create(admin.cookie, 'Second Org');

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message: STAFF_REFUSAL,
      });
    });

    it('tells the owner of another Organization who can add a license, naming no Organization and giving no count', async () => {
      const ownerSession = await signUp(server, owner);
      const instanceOrganizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
        { organizationName: 'Mallory Ltd' },
      );

      const refused = await create(mallory.cookie, 'Third Org');

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message: PLAIN_REFUSAL,
      });
      const text = JSON.stringify(refused.body);
      expect(text).not.toContain('My Organization');
      expect(text).not.toContain(instanceOrganizationId);
      expect((refused.body as { message: string }).message).not.toMatch(/\d/);

      expect(await creation(mallory.cookie)).toEqual({
        allowed: false,
        reason: PLAIN_REFUSAL,
        code: 'ORGANIZATION_LIMIT',
        licenseHint: false,
        overLimit: { count: null },
        ownedPayingForThemselves: null,
        planHint: null,
      });
    });

    it('refuses a plain member for their role first, as before', async () => {
      const { invitee } = await setUpOrgWithMember(server);

      const refused = await create(invitee.cookie, 'Rogue Org');

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        message: 'Only the organization owner can create an organization',
      });
      expect(refused.body).not.toHaveProperty('code');
      expect(await creation(invitee.cookie)).toMatchObject({
        allowed: false,
        reason: 'Only the organization owner can create an organization',
        code: null,
        licenseHint: false,
      });
    });

    it('lets a valid license on the Instance organization lift the limit, and refuses again once it passes validUntil, keeping what exists', async () => {
      const ownerSession = await signUp(server, owner);
      const instanceOrganizationId = await activeOrganizationId(
        server,
        ownerSession.cookie,
      );
      await license(instanceOrganizationId, new Date(Date.now() + 86_400_000));

      expect(await creation(ownerSession.cookie)).toEqual({
        allowed: true,
        reason: null,
        code: null,
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: null,
        planHint: null,
      });
      expect((await create(ownerSession.cookie, 'Second Org')).status).toBe(
        201,
      );
      expect((await create(ownerSession.cookie, 'Third Org')).status).toBe(201);

      await ctx.db
        .update(licenseKey)
        .set({ validUntil: new Date(Date.now() - 1000) })
        .where(eq(licenseKey.organizationId, instanceOrganizationId));

      const refused = await create(ownerSession.cookie, 'Fourth Org');
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message: STAFF_REFUSAL,
      });
      expect(await organizationCount(ownerSession.cookie)).toBe(3);
      expect(await creation(ownerSession.cookie)).toEqual({
        allowed: false,
        reason: STAFF_REFUSAL,
        code: 'ORGANIZATION_LIMIT',
        licenseHint: true,
        overLimit: { count: 3 },
        ownedPayingForThemselves: null,
        planHint: null,
      });
    });

    it('does not let a license on any other Organization lift the limit', async () => {
      const ownerSession = await signUp(server, owner);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );
      await license(mallory.organizationId, null);

      const theirs = await create(mallory.cookie, 'Third Org');
      expect(theirs.status).toBe(403);
      expect(theirs.body).toMatchObject({ code: 'ORGANIZATION_LIMIT' });

      const instanceOwners = await create(ownerSession.cookie, 'Third Org');
      expect(instanceOwners.status).toBe(403);
      expect(instanceOwners.body).toMatchObject({
        code: 'ORGANIZATION_LIMIT',
        message: STAFF_REFUSAL,
      });
    });

    it('greys out "New organization" for the Instance organization\'s owner with the license hint', async () => {
      const ownerSession = await signUp(server, owner);

      expect(await creation(ownerSession.cookie)).toEqual({
        allowed: false,
        reason: STAFF_REFUSAL,
        code: 'ORGANIZATION_LIMIT',
        licenseHint: true,
        overLimit: null,
        ownedPayingForThemselves: null,
        planHint: null,
      });
    });

    it('says an instance is over the limit to owners and admins only, with the count for the Instance organization, and counts only what exists', async () => {
      const ownerSession = await signUp(server, owner);
      const plain = await signUpMember(server, ownerSession.cookie);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );
      const third = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Third Org' },
      );
      expect(third.status).toBe(201);

      expect((await creation(ownerSession.cookie)).overLimit).toEqual({
        count: 3,
      });
      expect((await creation(mallory.cookie)).overLimit).toEqual({
        count: null,
      });
      expect((await creation(plain.cookie)).overLimit).toBeNull();

      const removed = await request(server)
        .delete(`/organizations/${(third.body as { id: string }).id}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      expect((await creation(ownerSession.cookie)).overLimit).toEqual({
        count: 2,
      });

      // The instance owner made Mallory's Organization, so may delete it too:
      // one is left, which is the limit, not over it.
      const second = await request(server)
        .delete(`/organizations/${mallory.organizationId}`)
        .set('Cookie', ownerSession.cookie);
      expect(second.status).toBe(200);
      expect((await creation(ownerSession.cookie)).overLimit).toBeNull();
    });
  });

  describe('organization management', () => {
    it('an owner can create an additional organization; a plain member cannot create any', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const created = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'Second Org',
        ownerId: ownerSession.id,
      });

      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', ownerSession.cookie);
      const list = orgs.body as OrgListItem[];
      expect(list).toHaveLength(2);
      const second = list.find((o) => o.name === 'Second Org')!;
      expect(second.member).toMatchObject({ role: 'owner' });

      const denied = await request(server)
        .post('/organizations')
        .set('Cookie', invitee.cookie)
        .send({ name: 'Rogue Org' });
      expect(denied.status).toBe(403);
    });

    it('only the owner can update an organization', async () => {
      const { owner: ownerSession, invitee } = await setUpOrgWithMember(server);

      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', ownerSession.cookie);
      const orgId = (orgs.body as OrgListItem[])[0].id;

      const denied = await request(server)
        .patch(`/organizations/${orgId}`)
        .set('Cookie', invitee.cookie)
        .send({ name: 'Hijacked' });
      expect(denied.status).toBe(403);

      const updated = await request(server)
        .patch(`/organizations/${orgId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'Acme' });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ id: orgId, name: 'Acme' });
    });

    it('the owner cannot delete their last owned organization, but can delete a second one', async () => {
      const { cookie } = await signUp(server, owner);

      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const firstOrgId = (orgs.body as OrgListItem[])[0].id;

      const deniedLast = await request(server)
        .delete(`/organizations/${firstOrgId}`)
        .set('Cookie', cookie);
      expect(deniedLast.status).toBe(403);

      const created = await createOrganization(server, ctx.db, cookie, {
        name: 'Second Org',
      });
      const secondOrgId = (created.body as { id: string }).id;

      const del = await request(server)
        .delete(`/organizations/${secondOrgId}`)
        .set('Cookie', cookie);
      expect(del.status).toBe(200);

      const after = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const names = (after.body as OrgListItem[]).map((o) => o.id);
      expect(names).toEqual([firstOrgId]);
    });

    it('the owner never deletes the Instance organization, even owning another (ADR-0077)', async () => {
      const { cookie } = await signUp(server, owner);
      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const instanceOrgId = (orgs.body as OrgListItem[])[0].id;
      await createOrganization(server, ctx.db, cookie, { name: 'Second Org' });

      const denied = await request(server)
        .delete(`/organizations/${instanceOrgId}`)
        .set('Cookie', cookie);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({
        code: 'INSTANCE_ORGANIZATION_UNDELETABLE',
      });

      const after = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      expect((after.body as OrgListItem[]).map((o) => o.id)).toContain(
        instanceOrgId,
      );
    });

    it('GET /organizations/:id returns the organization to members only', async () => {
      const { cookie } = await signUp(server, owner);
      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', cookie);
      const orgId = (orgs.body as OrgListItem[])[0].id;

      const res = await request(server)
        .get(`/organizations/${orgId}`)
        .set('Cookie', cookie);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ id: orgId, name: 'My Organization' });

      // A second, unrelated org is not visible to a non-member: create a
      // second org and check the invitee (member of the first only) is denied.
      const second = await createOrganization(server, ctx.db, cookie, {
        name: 'Second Org',
      });
      const secondId = (second.body as { id: string }).id;

      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', cookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      const inviteId = (invite.body as { id: string }).id;
      const su = await request(server)
        .post('/api/auth/sign-up/email')
        .set('x-cloudgate-token', inviteId)
        .send({
          name: 'Ida Rhodes',
          email: 'invitee@example.com',
          password: 'super-secret-password',
        });
      const inviteeCookie = su.headers['set-cookie'];
      await request(server)
        .post(`/organizations/invitations/${inviteId}/accept`)
        .set('Cookie', inviteeCookie);

      const denied = await request(server)
        .get(`/organizations/${secondId}`)
        .set('Cookie', inviteeCookie);
      expect(denied.status).toBe(403);
    });

    it('set-default changes which organization new sessions start in', async () => {
      const { cookie } = await signUp(server, owner);

      const created = await createOrganization(server, ctx.db, cookie, {
        name: 'Second Org',
      });
      const secondId = (created.body as { id: string }).id;

      const setDefault = await request(server)
        .post(`/organizations/${secondId}/set-default`)
        .set('Cookie', cookie);
      expect(setDefault.status).toBe(200);

      const signIn = await request(server)
        .post('/api/auth/sign-in/email')
        .send({ email: owner.email, password: owner.password });
      const freshCookie = signIn.headers['set-cookie'];

      const session = await request(server)
        .get('/api/auth/get-session')
        .set('Cookie', freshCookie);
      const body = session.body as {
        session: { activeOrganizationId: string | null };
      };
      expect(body.session.activeOrganizationId).toBe(secondId);
    });
  });
});
