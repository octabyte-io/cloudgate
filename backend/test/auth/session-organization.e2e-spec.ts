import { and, eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { auditLog } from '../../src/enterprise/audit-logs/audit-log.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { signUpMember, createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

/**
 * Which Organization a new session starts in.
 *
 * The session `create.after` hook in `auth.config.ts` answers only when the
 * answer is already known — the membership marked default, or the only one —
 * and leaves `activeOrganizationId` unset for several memberships with no
 * default, so the console's sign-in asks with "Choose an Organization". It used
 * to fall back to the most recently joined one, which made that screen
 * unreachable from sign-in.
 *
 * The member is Ida, invited into the instance Organization first and a second
 * one after, so "most recently joined" and "first joined" are different
 * answers and the control cases can tell a default from a fallback.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ida = {
  email: 'ida@example.com',
  password: 'super-secret-password',
};

/** The `Cookie` header a browser holding these `Set-Cookie`s would send. */
function cookieOf(setCookie: unknown): string {
  return (setCookie as string[]).map((entry) => entry.split(';')[0]).join('; ');
}

describe('The Organization a new session starts in (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  async function signUpOwner(): Promise<string> {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    return cookieOf(res.headers['set-cookie']);
  }

  async function activeOf(cookie: string): Promise<string | null> {
    const res = await request(server)
      .get('/api/auth/get-session')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return (res.body as { session: { activeOrganizationId: string | null } })
      .session.activeOrganizationId;
  }

  async function setActive(cookie: string, organizationId: string) {
    const res = await request(server)
      .post('/api/auth/organization/set-active')
      .set('Cookie', cookie)
      .send({ organizationId });
    expect(res.status).toBe(200);
  }

  async function signIn(): Promise<string> {
    const res = await request(server).post('/api/auth/sign-in/email').send(ida);
    expect(res.status).toBe(200);
    return cookieOf(res.headers['set-cookie']);
  }

  /**
   * Ida is a member of the instance Organization; with `second`, she is then
   * invited into another one the owner creates, and accepts.
   */
  async function setUp({ second }: { second: boolean }) {
    const ownerCookie = await signUpOwner();
    const first = await activeOf(ownerCookie);
    const member = await signUpMember(server, ownerCookie, {
      email: ida.email,
      password: ida.password,
    });
    if (!second) return { first: first!, second: null, member };

    const created = await createOrganization(server, ctx.db, ownerCookie, {
      name: 'Second Org',
    });
    expect(created.status).toBe(201);
    const secondId = (created.body as { id: string }).id;

    // An invitation lands in the inviter's active Organization.
    await setActive(ownerCookie, secondId);
    const invite = await request(server)
      .post('/organizations/invitations')
      .set('Cookie', ownerCookie)
      .send({ email: ida.email, role: 'member' });
    expect(invite.status).toBe(201);
    const accepted = await request(server)
      .post(
        `/organizations/invitations/${(invite.body as { id: string }).id}/accept`,
      )
      .set('Cookie', member.cookie);
    expect(accepted.status).toBe(201);

    return { first: first!, second: secondId, member };
  }

  /** Ida's `login` rows on one Organization's trail. */
  async function loginsIn(organizationId: string, userId: string) {
    const rows = await ctx.db
      .select({ id: auditLog.auditLogId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.organizationId, organizationId),
          eq(auditLog.userId, userId),
          eq(auditLog.action, 'login'),
        ),
      );
    return rows.length;
  }

  it('leaves it unset for several memberships and no default, so sign-in asks', async () => {
    const { first, second, member } = await setUp({ second: true });
    // Counted from here: accepting her first invitation put her sign-up
    // session in an Organization for the first time, which is itself a login.
    const earlier = {
      first: await loginsIn(first, member.id),
      second: await loginsIn(second!, member.id),
    };

    const cookie = await signIn();

    expect(await activeOf(cookie)).toBeNull();
    // No Organization, so no trail is told about it yet — not every one.
    expect(await loginsIn(first, member.id)).toBe(earlier.first);
    expect(await loginsIn(second!, member.id)).toBe(earlier.second);

    // Choosing is what records it, on the chosen trail only.
    await setActive(cookie, second!);
    expect(await loginsIn(second!, member.id)).toBe(earlier.second + 1);
    expect(await loginsIn(first, member.id)).toBe(earlier.first);

    // Switching afterwards is not a login.
    await setActive(cookie, first);
    expect(await loginsIn(first, member.id)).toBe(earlier.first);
  });

  it('starts in the only Organization there is', async () => {
    const { first } = await setUp({ second: false });

    expect(await activeOf(await signIn())).toBe(first);
  });

  it('starts in the default, even when it is not the newest', async () => {
    const { first, member } = await setUp({ second: true });
    const setDefault = await request(server)
      .post(`/organizations/${first}/set-default`)
      .set('Cookie', member.cookie);
    expect(setDefault.status).toBe(200);

    expect(await activeOf(await signIn())).toBe(first);
  });
});
