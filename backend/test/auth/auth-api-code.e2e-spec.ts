import { Controller, Get } from '@nestjs/common';
import { APIError } from 'better-auth/api';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { callAuthApi } from '../../src/auth/auth-api.util';
import { Public } from '../../src/auth/decorators/public.decorator';
import { member, user } from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * What a better-auth refusal carries once it has come through a Cloudgate route
 * (H-36, the third layer of H-26).
 *
 * `AllExceptionsFilter` learned to publish a `code` in H-26 and `callAuthApi`
 * did not, so it went on flattening every `APIError` to `new
 * HttpException(message, status)` — and better-auth names *every* refusal it
 * raises. The consequence is one refusal with two sentences: reached through
 * better-auth's own client, `YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION` and
 * `ORGANIZATION_MEMBERSHIP_LIMIT_REACHED` arrive as codes and the console says
 * what happened; reached through `POST /organizations/invitations/:id/accept`,
 * the same two arrived as a bare **403** and the console has exactly one
 * sentence for those — *"Your role in this Organization does not allow this"* —
 * which is wrong for both and names a fix (ask for a different role) that helps
 * with neither.
 *
 * **Driven through the real routes, not asserted on the util.** A unit test on
 * `callAuthApi` would prove it builds a different object and would have passed
 * just as well if `AllExceptionsFilter` dropped the field again; the point of
 * the finding is the wire, so the wire is what is read here.
 *
 * The freshness refusal is the exception and it says so where it is asserted:
 * `auth.config.ts` sets `freshAge: 0`, so no request this build can make reaches
 * better-auth's freshness check at all.
 *
 * Banned by nothing here — this file is about refusals better-auth raises on its
 * own account. `banned-session-read.e2e-spec.ts` covers the ones Cloudgate
 * raises.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PASSWORD = 'super-secret-password';

/**
 * A route that raises a better-auth refusal inside `callAuthApi` without asking
 * better-auth to be in the state that raises it.
 *
 * Registered for the freshness case and nothing else. `SESSION_NOT_FRESH` is the
 * refusal `sessions-card.tsx` was string-matching, and it is **unreachable on
 * this build**: `freshSessionMiddleware` returns early when `freshAge` is `0`
 * and `auth.config.ts` sets it to `0` deliberately. So the choice was
 * between asserting nothing about the one code the console was matching English
 * for, and raising better-auth's own `APIError` on a real route through the real
 * filter. The second is what is done, and what it does not prove is stated:
 * that better-auth's middleware still spells the code this way. That claim is
 * pinned by `auth.config.ts`'s own docblock and by the freshness case below,
 * which drives the live route and records that it answers 200.
 */
@Public()
@Controller('auth-api-code-probe')
class AuthApiCodeProbeController {
  @Get('not-fresh')
  notFresh(): Promise<never> {
    return callAuthApi(() => {
      // The literal better-auth raises at
      // `api/routes/session.mjs`'s `freshSessionMiddleware`, which is
      // `APIError.from("FORBIDDEN", BASE_ERROR_CODES.SESSION_NOT_FRESH)` —
      // spelled out because `@better-auth/core` is not a dependency of this
      // workspace and `APIError.from` only copies these two fields across.
      throw new APIError('FORBIDDEN', {
        message: 'Session is not fresh',
        code: 'SESSION_NOT_FRESH',
      });
    });
  }

  @Get('unnamed')
  unnamed(): Promise<never> {
    return callAuthApi(() => {
      throw new APIError('FORBIDDEN', {
        message: 'Refused for no named reason',
      });
    });
  }
}

describe('A better-auth refusal through a Cloudgate route (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp({ controllers: [AuthApiCodeProbeController] });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  async function signUp(
    body: { name: string; email: string; password: string },
    invitationId?: string,
  ): Promise<{ cookie: string; id: string }> {
    const req = request(server).post('/api/auth/sign-up/email');
    if (invitationId) req.set('x-cloudgate-token', invitationId);
    const res = await req.send(body);
    expect(res.status).toBe(200);
    return {
      cookie: res.headers['set-cookie'],
      id: (res.body as { user: { id: string } }).user.id,
    };
  }

  async function invite(cookie: string, email: string): Promise<string> {
    const res = await request(server)
      .post('/organizations/invitations')
      .set('Cookie', cookie)
      .send({ email, role: 'member' });
    expect(res.status).toBe(201);
    return (res.body as { id: string }).id;
  }

  /**
   * The finding, on the route the OpenAPI contract publishes.
   *
   * Two accounts and one invitation addressed to the first: better-auth compares
   * the invitation's email against the session's and refuses. It is a **403**,
   * which is the status the console reads as a role problem — and a role is the
   * one thing that cannot be wrong here, because the second account has no
   * membership of that Organization at all.
   */
  it("carries better-auth's code for a wrong-recipient accept", async () => {
    const ownerSession = await signUp(owner);
    const idasInvitation = await invite(ownerSession.cookie, 'ida@example.com');
    // Two invitations, because the instance is closed and `assertSignUpAllowed`
    // refuses a sign-up whose address does not match the token it arrived with
    // (`INVITATION_EMAIL_MISMATCH`). So Ada gets in on her own invitation and
    // then reaches for Ida's — which is the shape of the real mistake: a link
    // forwarded to, or opened in a browser already signed in as, somebody else.
    const adasInvitation = await invite(ownerSession.cookie, 'ada@example.com');
    const wrongAccount = await signUp(
      { name: 'Ada Lovelace', email: 'ada@example.com', password: PASSWORD },
      adasInvitation,
    );

    const res = await request(server)
      .post(`/organizations/invitations/${idasInvitation}/accept`)
      .set('Cookie', wrongAccount.cookie);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      statusCode: 403,
      error: 'Forbidden',
      message: 'You are not the recipient of the invitation',
      code: 'YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION',
      path: `/organizations/invitations/${idasInvitation}/accept`,
    });
  });

  /**
   * The second 403 on the same route, and the reason the fix is the util rather
   * than a case in the console: these two refusals are indistinguishable by
   * status, by route and by method. Only the code tells "you are signed in as
   * the wrong person" from "this Organization is full".
   *
   * The Organization is filled by writing `member` rows rather than by signing
   * 99 people up. The check is `adapter.countMembers`, a count and nothing more,
   * and 99 sign-ups would spend a minute and a half hashing passwords to reach
   * the same number.
   */
  it('carries the membership-limit code for an accept into a full Organization', async () => {
    const ownerSession = await signUp(owner);
    const invitationId = await invite(ownerSession.cookie, 'ida@example.com');
    const invitee = await signUp(
      { name: 'Ida Rhodes', email: 'ida@example.com', password: PASSWORD },
      invitationId,
    );

    // The owner's membership, and the only one there is: `bootstrapDefaultOrganization`
    // no-ops once an instance has an owner, so an invited account holds no
    // `member` row at all until it accepts.
    const [ownerMembership] = await ctx.db
      .select({ organizationId: member.organizationId })
      .from(member)
      .where(eq(member.userId, ownerSession.id));
    const organizationId = ownerMembership.organizationId;

    // better-auth's default limit is 100 and `auth.config.ts` does not set one,
    // so 100 rows — the owner's included — is the state that refuses the 101st.
    const now = new Date();
    const fillers = Array.from({ length: 99 }, (_, index) => ({
      id: `filler-user-${index}`,
      email: `filler-${index}@example.com`,
      updatedAt: now,
    }));
    await ctx.db.insert(user).values(fillers);
    await ctx.db.insert(member).values(
      fillers.map((filler, index) => ({
        id: `filler-member-${index}`,
        organizationId,
        userId: filler.id,
        role: 'member',
        createdAt: now,
      })),
    );

    const res = await request(server)
      .post(`/organizations/invitations/${invitationId}/accept`)
      .set('Cookie', invitee.cookie);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Organization membership limit reached',
      code: 'ORGANIZATION_MEMBERSHIP_LIMIT_REACHED',
    });
  });

  /**
   * The freshness refusal, through the filter on a real route.
   *
   * See the probe controller's own note for what this does and does not claim.
   * It is here because `SESSION_NOT_FRESH` is the code
   * `frontend/src/features/settings/account/sessions-card.tsx` matched the
   * **English** of — "the last string match left in the app", by its own comment,
   * naming this util's flattening as the reason it had to.
   */
  it('carries the freshness code rather than only its English', async () => {
    const res = await request(server).get('/auth-api-code-probe/not-fresh');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      statusCode: 403,
      error: 'Forbidden',
      message: 'Session is not fresh',
      code: 'SESSION_NOT_FRESH',
    });
  });

  /**
   * The control on all three, and the contract H-26 wrote down: a `code` appears
   * only where one was published. better-auth names every refusal it raises, so
   * this is the one shape that proves the field is copied rather than invented —
   * an `APIError` with no `code` in its body still answers with the body it
   * always did.
   */
  it('leaves a refusal that named itself nothing without a code', async () => {
    const res = await request(server).get('/auth-api-code-probe/unnamed');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ message: 'Refused for no named reason' });
    expect(res.body).not.toHaveProperty('code');
  });

  /**
   * Why the freshness case above is a probe and not this route.
   *
   * `GET /users/me/sessions` rides better-auth's `freshSessionMiddleware`, which
   * is the only thing in the tree that raises `SESSION_NOT_FRESH` — and
   * `freshAge: 0` skips it outright, so the refusal the console has a
   * whole card state for cannot be produced by any request this build serves.
   * Asserted rather than assumed: if freshness is ever turned back on, this is
   * the test that says so.
   */
  it('answers the session listing rather than refusing it as stale', async () => {
    const ownerSession = await signUp(owner);

    const res = await request(server)
      .get('/users/me/sessions')
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
