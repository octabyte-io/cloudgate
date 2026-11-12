import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import type { Auth } from '../../src/auth/auth.config';
import { AUTH } from '../../src/auth/auth.constants';
import { user } from '../../src/auth/auth.schema';
import { BANNED_CODE } from '../../src/auth/ban';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * The invariant behind H-08, rather than the instance of it (H-27).
 *
 * `AuthController` is `@Public()` over an `@All('*splat')`, so nothing on
 * `/api/auth/*` passes through `AuthService.resolveCaller` — where every rule
 * about the *account* behind a credential lives. H-08 was that fact costing a
 * banned operator's console a full live session body from `/get-session`; the
 * fix was `refuseBannedSession`, `auth.config.ts`'s top-level `hooks.after`.
 * `banned-session-read.e2e-spec.ts` pins that fix on the four routes the live
 * capture named.
 *
 * **This file pins the cover, not the routes.** The next account-level
 * condition — disabled, deleted, organization removed, credentials rotated —
 * will be invisible on this surface for the same structural reason, and a spec
 * naming routes by hand cannot notice a route it does not name. So the surface
 * is enumerated out of better-auth's own route table (`auth.api`), and the
 * claim is measured against itself: **a route that answers a live cookie must
 * not answer a banned one the same way.**
 *
 * That shape is deliberate and is what makes the file able to fail. An absolute
 * list — "these paths must 403" — needs maintaining against a dependency's
 * route table, and every entry nobody adds is a hole. A differential one needs
 * nothing: an endpoint that 400s for a missing query parameter, or 404s, or is
 * not implemented on this build, drops out of both sides on its own, and only
 * the endpoints that really do serve a signed-in caller are asked the question.
 *
 * Rejected: asserting the wiring instead — that `createAuth`'s config carries a
 * `hooks.after`, or grepping `auth.config.ts` for `refuseBannedSession`. It is
 * the cheap version of this test and it is the wrong claim. The hook can be
 * present and stop covering the surface in three ways this file catches and
 * that one does not: `BAN_EXEMPT_PATHS` growing, the check moving into a plugin
 * whose hooks run after another plugin's, and the resolution falling back to a
 * context that no longer carries a session. The enumeration in
 * `test/realtime/gateway-leases.e2e-spec.ts` is the same instinct — count the
 * surface, not the fixes.
 *
 * `NODE_ENV` is left at jest's own `test`, as in `banned-session-read`: nothing
 * here reads an address, and production would turn on better-auth's origin
 * check for the credentialed requests below.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * `auth.config.ts`'s `BAN_EXEMPT_PATHS`, restated because it is not exported —
 * and restated as a *bound*, not as a copy.
 *
 * The assertion below is that the banned-and-still-served set is a subset of
 * this one, so a second entry appearing in `auth.config.ts` and not here fails
 * this file rather than passing it. That is the direction the copy has to point:
 * an exemption is the one edit to that hook which silently reopens H-08 for one
 * route, and it should cost a deliberate line here.
 *
 * `/sign-out` is a POST, so on this file's GET enumeration the expected set is
 * empty — the subset test is written against the constant anyway, because a
 * hard-coded "nothing" would have to be re-reasoned the day the exemption for
 * the door out is joined by a second one.
 */
const BAN_EXEMPT_PATHS = new Set(['/sign-out']);

/** A 2xx: the surface served this caller rather than refusing them. */
const served = (status: number): boolean => status >= 200 && status < 300;

interface Probe {
  path: string;
  live: number;
  banned: number;
  /** better-auth's `code` off the banned response, when it carried one. */
  bannedCode: string | undefined;
}

describe('The /api/auth account-level cover (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let probes: Probe[];

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
    await ctx.resetDb();
    probes = await probeSurface();
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  /**
   * Every GET better-auth publishes that a browser could actually call, taken
   * from the instance this app is running rather than from a list.
   *
   * GET only, and paths with no parameter in them, because the question is
   * "does the cover reach this route" and a route that needs a provider id or a
   * body to be reached at all cannot answer it — it would 400 on both passes
   * and drop out of the differential anyway, at the cost of a request each. The
   * two that are excluded by shape rather than by outcome are the parameterised
   * OAuth callbacks, which are GETs that redirect somewhere.
   */
  function surfaceGets(): string[] {
    const auth = ctx.app.get<Auth>(AUTH);
    const endpoints = Object.values(
      auth.api as unknown as Record<string, unknown>,
    );
    const paths = new Set<string>();
    for (const endpoint of endpoints) {
      const described = endpoint as {
        path?: unknown;
        options?: { method?: unknown };
      };
      if (typeof described.path !== 'string') continue;
      if (described.path.includes(':') || described.path.includes('*'))
        continue;
      const method = described.options?.method;
      const methods = Array.isArray(method) ? method : [method];
      if (!methods.includes('GET')) continue;
      paths.add(described.path);
    }
    return [...paths].sort();
  }

  /**
   * The surface, asked twice with the same account: once while it is in good
   * standing and once after two columns change under it.
   *
   * One account and one app rather than two of either, so nothing but `banned`
   * and `ban_expires` differs between the passes — the same control
   * `banned-session-read.e2e-spec.ts` makes with its unbanned case, and the one
   * the live H-08 capture made by unbanning and getting the same session back
   * in the same tab.
   */
  async function probeSurface(): Promise<Probe[]> {
    const signUp = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    const cookie = (signUp.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const userId = (signUp.body as { user: { id: string } }).user.id;

    const paths = surfaceGets();
    const live = new Map<string, number>();
    for (const path of paths) {
      const res = await request(httpServer)
        .get(`/api/auth${path}`)
        .set('Cookie', cookie);
      live.set(path, res.status);
    }

    // Written straight onto the columns, as every other ban spec here does it:
    // `/admin/ban-user` answers 403 to every account this build can create
    // (`auth.config.ts`'s `admin({ adminRoles: [] })`), so driving it would test
    // a fact about the build rather than the thing under test.
    await ctx.db
      .update(user)
      .set({ banned: true, banExpires: null })
      .where(eq(user.id, userId));

    const results: Probe[] = [];
    for (const path of paths) {
      const res = await request(httpServer)
        .get(`/api/auth${path}`)
        .set('Cookie', cookie);
      results.push({
        path,
        live: live.get(path)!,
        banned: res.status,
        bannedCode: (res.body as { code?: string } | null)?.code,
      });
    }
    return results;
  }

  /**
   * The claim H-27 asks for, and the one that goes red when the cover goes
   * away: nothing that served this caller still serves them once the account is
   * refused.
   *
   * Removing `hooks.after` from `auth.config.ts`, or narrowing it to
   * `/get-session`, or adding a path to `BAN_EXEMPT_PATHS`, each turns the
   * offending route back into a route that answers both passes the same way,
   * and each is named here by path rather than by a bare count.
   */
  it('serves no GET on the surface to a banned account that it served live', () => {
    const stillServed = probes
      .filter((probe) => served(probe.live) && served(probe.banned))
      .map((probe) => probe.path)
      .filter((path) => !BAN_EXEMPT_PATHS.has(path));

    expect(stillServed).toEqual([]);
  });

  /**
   * The refusal is the ban's, not something else's — a route that started
   * 500ing would satisfy the test above while telling the operator nothing, and
   * would be this finding again in another shape.
   */
  it("refuses each of them as the ban, in better-auth's own vocabulary", () => {
    const refused = probes.filter((probe) => served(probe.live));
    expect(refused.length).toBeGreaterThan(0);

    expect(
      refused.map((probe) => ({
        path: probe.path,
        status: probe.banned,
        code: probe.bannedCode,
      })),
    ).toEqual(
      refused.map((probe) => ({
        path: probe.path,
        status: 403,
        code: BANNED_CODE,
      })),
    );
  });

  /**
   * The guard on the guard. A differential test passes brilliantly when it
   * measures nothing, so the enumeration is pinned to the two routes the live
   * H-08 capture caught — `/get-session`, the read the console gates on, and
   * `/organization/list`, the Organization it draws its whole scope rail from —
   * plus a floor under the surface's width, so an `auth.api` shape change that
   * silently yields one endpoint fails here rather than turning the file green.
   *
   * The floor is 12 against 19 observed on this build — a lower bound, not a
   * count, because five of the nineteen are the SCIM and SSO plugins' and an
   * instance without the enterprise licence publishes fewer. A number that
   * tracked the surface exactly would be a second thing to maintain every time
   * better-auth ships a route, which is the maintenance this file is built to
   * avoid.
   */
  it('enumerates a surface wide enough for that claim to mean something', () => {
    const live = probes
      .filter((probe) => served(probe.live))
      .map((probe) => probe.path);

    expect(live).toContain('/get-session');
    expect(live).toContain('/organization/list');
    expect(live.length).toBeGreaterThanOrEqual(12);
  });

  /**
   * And the account really is refused rather than merely unrecognised: a 401
   * would satisfy every assertion above and mean the cookie stopped being read,
   * which is not what a banned account is being told. The code is
   * `BANNED_USER`, better-auth's own, so the console learns one spelling of this
   * fact rather than two (`ban.ts`).
   */
  it('leaves a caller with no account at all unrefused', async () => {
    const probe = probes.find((entry) => entry.path === '/get-session');
    expect(probe).toBeDefined();
    expect(probe!.bannedCode).toBe(BANNED_CODE);

    const res = await request(httpServer)
      .get('/api/auth/get-session')
      .set('Cookie', 'x=y');
    // The anonymous control: no cookie at all is not a refusal of an account.
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });
});
