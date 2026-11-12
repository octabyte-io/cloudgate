import { Controller, Get, Req } from '@nestjs/common';
import { desc, eq } from 'drizzle-orm';
import type { Request as ExpressRequest } from 'express';
import request from 'supertest';
import { App } from 'supertest/types';

import { session } from '../../src/auth/auth.schema';
import { Public } from '../../src/auth/decorators/public.decorator';
import { auditLog } from '../../src/enterprise/audit-logs/audit-log.schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * What `session.ip_address` actually holds after a real sign-in.
 *
 * better-auth writes that column itself — `createSession` stores
 * `getIp(headers) || ""` — and `getIp` reads a *header*, never the socket. So
 * before `toWebRequest` filled one in, every session created by a caller that
 * sends no `x-forwarded-for` stored an empty address: `curl` straight at the
 * backend, and any deployment with nothing in front of Nest. Settings → Account
 * → Sessions then rendered its dash in every row, and three `curl/8.5.0` rows
 * had nothing left to tell them apart.
 *
 * **`NODE_ENV` is `production` here, and that is what makes the spec able to
 * fail.** `getIp` ends with `if (isTest() || isDevelopment()) return "127.0.0.1"`
 * — under jest's own `NODE_ENV=test` a broken app and a fixed one both answer
 * `127.0.0.1`, so every assertion below would pass while proving nothing. The
 * same trick, for the same reason, as `trusted-origins.e2e-spec.ts`. Set before
 * `createTestApp` requires AppModule, because `@better-auth/core` snapshots
 * `NODE_ENV` when it is first imported.
 *
 * No request here carries a `Cookie`, an `Origin` or a `Sec-Fetch-*` header,
 * which is what keeps better-auth's origin check out of the way: production
 * turns `skipOriginCheck` off, and `validateOrigin` returns early for a request
 * that is not credentialed.
 */
const nodeEnvBefore = process.env.NODE_ENV;
process.env.NODE_ENV = 'production';

// The hops this instance trusts to name the caller, set before
// createTestApp requires AppModule for the same snapshot reason.
//
// **`loopback` has to be in the list, and the trusted-proxy fix is why.**
// supertest connects from
// 127.0.0.1, so under the previous fixture — `10.0.0.0/8` alone — the socket peer
// was outside every declared range. That is not a deployment; it is the mixed
// ingress the trusted-proxy fix exists to shut, and four of the cases below were
// asserting the behaviour it removes. Declaring loopback makes the file describe something
// real: nginx or Traefik on this host proxying to 127.0.0.1:4000, itself reached
// through a load balancer in 10.0.0.0/8.
//
// The private range stays for the two-hop case: with both declared, a chain
// `client, 10.0.0.9` arriving from loopback is stripped past both proxies to the
// client, which is the assertion `strips a forwarded chain` exists to make and
// could not survive on `loopback` alone.
const trustProxyBefore = process.env.TRUST_PROXY;
process.env.TRUST_PROXY = 'loopback,10.0.0.0/8';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/**
 * The address of a caller that arrives *from* a declared proxy and names nobody
 * — the socket peer, which on this fixture is supertest's loopback.
 *
 * better-auth cannot answer this case at all: the column is
 * `getIp(headers) || ""`, and a walk that steps past every declared hop runs off
 * the left end of the chain and returns `null`. It used to be recorded as `''`,
 * and this spec used to pin that blank as correct. It is not: the blank is the
 * Sessions screen's dash, a blank `ip` on the login entry in the audit trail,
 * and better-auth's sign-in throttle keyed on the literal `no-trusted-ip` for
 * every caller in that state at once. The peer travels on
 * `SOCKET_PEER_HEADER` and the `session.create.before` hook fills it in.
 */
const SOCKET_PEER = '127.0.0.1';
/** A client one hop away, the way a proxy would name it. */
const FORWARDED_CLIENT = '203.0.113.7';
/** A second client, so two sessions of one account differ by address alone. */
const OTHER_CLIENT = '198.51.100.23';

/** What the probe below hands back — Express's own reading of the request. */
interface ExpressPeer {
  ip: string | undefined;
  ips: string[];
}

/**
 * What Express itself made of the request, on a route that is not better-auth's
 * (H-28).
 *
 * `req.ip` and `req.ips` are the only observable of the `trust proxy` setting,
 * and nothing in `src` echoes them — the audit trail's writers store them, which
 * is a slower and more indirect way to ask the same question. A probe
 * controller is what `TestAppOptions.controllers` exists for, and it keeps the
 * claim on the wire rather than on the app object: asserting
 * `app.get('trust proxy')` would prove the harness called `set`, not that a
 * request went through the matcher it compiled.
 */
@Public()
@Controller('__express-peer')
class ExpressPeerProbe {
  @Get()
  read(@Req() req: ExpressRequest): ExpressPeer {
    return { ip: req.ip, ips: req.ips };
  }
}

describe('Session address (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  beforeAll(async () => {
    ctx = await createTestApp({ controllers: [ExpressPeerProbe] });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    if (nodeEnvBefore === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = nodeEnvBefore;
    if (trustProxyBefore === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = trustProxyBefore;
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  /** The address on the session that was written last. */
  async function newestSessionAddress(): Promise<string | null> {
    const [row] = await ctx.db
      .select()
      .from(session)
      .orderBy(desc(session.createdAt))
      .limit(1);
    expect(row).toBeDefined();
    return row.ipAddress;
  }

  /**
   * The wiring this whole file assumes, asserted rather than assumed (H-28).
   *
   * `createTestApp` never called `app.set('trust proxy', …)` and `main.ts` did,
   * so every e2e ran with Express's matcher and better-auth's declared list
   * disagreeing — and this file, whose entire subject is that
   * `loopback,10.0.0.0/8` is configured correctly, ran on an app that trusted
   * nothing. Every assertion below still passed, because they all read the
   * *better-auth* half, which `AuthModule` wires off the same key and which was
   * never broken. That is what made the gap latent: the suite could not see the
   * half it was not asking about.
   *
   * Since H-07 the gap reached product code too. `toWebRequest`'s
   * untrusted-peer test asks `req.app.get('trust proxy fn')` and is silent when
   * there is no matcher to ask, so under the old harness every e2e took the
   * "unanswerable" branch and no e2e has ever exercised the branch a deployment
   * runs. It now does.
   *
   * The direct request is the control: with nothing forwarded, `req.ips` is
   * empty whether or not a proxy is declared, so it is the forwarded pair below
   * that carries the claim.
   */
  it('trusts the hops TRUST_PROXY declares, the way main.ts does', async () => {
    const direct = await request(httpServer).get('/__express-peer');
    expect(direct.status).toBe(200);
    expect((direct.body as ExpressPeer).ips).toEqual([]);

    const forwarded = await request(httpServer)
      .get('/__express-peer')
      .set('x-forwarded-for', FORWARDED_CLIENT);
    expect(forwarded.status).toBe(200);
    // Untrusted, Express reports the socket peer here and an empty chain — which
    // is what this app did on every e2e before the harness shared main.ts's call.
    expect((forwarded.body as ExpressPeer).ip).toBe(FORWARDED_CLIENT);
    expect((forwarded.body as ExpressPeer).ips).toEqual([FORWARDED_CLIENT]);
  });

  /**
   * The point of one key with two readers, now checkable in one test: Express
   * and better-auth are shown the same chain and name the same client.
   *
   * `trust-proxy.ts`'s docblock calls these "two halves of one decision" and
   * says the failure mode of two keys is a `session.ip_address` that is silently
   * the proxy's rather than the person's. Until H-28 the harness produced that
   * state by construction, and nothing could tell — this is the assertion that
   * now would.
   */
  it('resolves the same client through Express as it records on the session', async () => {
    const chain = `${FORWARDED_CLIENT}, 10.0.0.9`;

    const probe = await request(httpServer)
      .get('/__express-peer')
      .set('x-forwarded-for', chain);
    expect((probe.body as ExpressPeer).ip).toBe(FORWARDED_CLIENT);

    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-forwarded-for', chain)
      .send(owner);
    expect(res.status).toBe(200);

    expect(await newestSessionAddress()).toBe(FORWARDED_CLIENT);
  });

  /**
   * And they stop at the same hop when the chain stops being trustworthy —
   * `refuses to believe an address an untrusted hop claims` below is this same
   * chain asked of the other half, and the two answers have to be the one
   * address.
   */
  it('stops at the same untrusted hop in both halves', async () => {
    const probe = await request(httpServer)
      .get('/__express-peer')
      .set('x-forwarded-for', `${FORWARDED_CLIENT}, 198.51.100.9`);

    expect((probe.body as ExpressPeer).ip).toBe('198.51.100.9');
    expect((probe.body as ExpressPeer).ip).not.toBe(FORWARDED_CLIENT);
  });

  /**
   * The case better-auth structurally cannot answer, and the one this file used
   * to pin the wrong way round.
   *
   * A caller reaching 127.0.0.1:4000 directly on a host whose loopback is
   * declared is, as far as configuration is concerned, a proxy that named
   * nobody — so better-auth's walk steps past it, finds nothing and resolves
   * `null`. The old assertion here was `''`, on the argument that blank beats
   * naming the proxy. Blank does not beat the socket peer: it is the same
   * `curl/8.5.0` dash an earlier fix removed, it blanks the login entry in the audit
   * trail, and it collapses better-auth's sign-in throttle onto one key
   * (`no-trusted-ip`) for every caller in this state — on an install that
   * declared a proxy in order to avoid exactly that. It is not an exotic corner
   * either: it is a health checker, a sidecar, and the browser at the far end of
   * the SSH tunnel `docs/deploy.md` §3 recommends.
   *
   * **This assertion only means something because `NODE_ENV` is `production`
   * here** — under jest's own `test` the `getIp` fallback answers `127.0.0.1`
   * whether the fix is present or not, which is the same reason the file sets it
   * at all.
   */
  it('records the socket peer when every hop in the chain is a declared proxy', async () => {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);

    expect(await newestSessionAddress()).toBe(SOCKET_PEER);
  });

  /**
   * The second reader of the same `null`, and the one that is not re-derivable
   * later: `recordSessionAudit` takes `ip` off the created row, so the login
   * entry went blank on exactly these requests. It is why the fill is a
   * `before` hook — an `after` one would need a second UPDATE and would still
   * write this entry blank.
   */
  it('names that peer on the login entry in the audit trail', async () => {
    expect(
      (await request(httpServer).post('/api/auth/sign-up/email').send(owner))
        .status,
    ).toBe(200);

    const [entry] = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'login'))
      .orderBy(desc(auditLog.createdAt))
      .limit(1);

    expect(entry).toBeDefined();
    expect(entry.ip).toBe(SOCKET_PEER);
  });

  /**
   * The other half of the fill rule, and the reason the fill cannot be "just write
   * the peer": an address better-auth *did* resolve is never touched, so there
   * is one writer per request and nothing for the two to drift about. Here the
   * proxy named a client, and the client is what is recorded — not the loopback
   * hop the request actually arrived from.
   */
  it('keeps the address a proxy forwarded rather than the hop it arrived from', async () => {
    expect(
      (await request(httpServer).post('/api/auth/sign-up/email').send(owner))
        .status,
    ).toBe(200);
    // Sign-up autoSignIn already left a session behind; clearing it leaves the
    // sign-in below as the only row, so the assertion cannot depend on two
    // `created_at` values being ordered.
    await ctx.db.delete(session);

    const res = await request(httpServer)
      .post('/api/auth/sign-in/email')
      .set('x-forwarded-for', FORWARDED_CLIENT)
      .send({ email: owner.email, password: owner.password });
    expect(res.status).toBe(200);

    expect(await newestSessionAddress()).toBe(FORWARDED_CLIENT);
  });

  /**
   * The point of the column, stated as the question someone auditing asks: two
   * sessions of the same account, from the same user-agent, are still told apart.
   */
  it('tells two sessions of one account apart by their addresses', async () => {
    expect(
      (
        await request(httpServer)
          .post('/api/auth/sign-up/email')
          .set('x-forwarded-for', OTHER_CLIENT)
          .send(owner)
      ).status,
    ).toBe(200);
    await request(httpServer)
      .post('/api/auth/sign-in/email')
      .set('x-forwarded-for', FORWARDED_CLIENT)
      .send({ email: owner.email, password: owner.password });

    const rows = await ctx.db.select().from(session);

    expect(rows).toHaveLength(2);
    // Two forwarded clients rather than one forwarded and one direct: on this
    // fixture a direct caller is a declared proxy and records nothing, and
    // a blank row against an addressed one would prove the two apart by the
    // absence of the column rather than by what it holds.
    expect(new Set(rows.map((row) => row.ipAddress))).toEqual(
      new Set([OTHER_CLIENT, FORWARDED_CLIENT]),
    );
    // The user-agent is what the console had to fall back on, and it is the same
    // on both rows — which is the whole reason the address has to arrive.
    expect(new Set(rows.map((row) => row.userAgent))).toHaveProperty('size', 1);
  });

  /**
   * Step 4 of the fix, and the half neither `toWebRequest` nor `trust proxy` can
   * do: better-auth throws away any `x-forwarded-for` carrying more than one
   * entry unless the hops are named (`@better-auth/core`
   * `dist/utils/ip.mjs:188`). So a deployment behind Traefik or a load balancer
   * recorded nothing at all, however correct the two steps in front of it were —
   * the chain arrived intact and was discarded for being a chain.
   *
   * Three entries reach better-auth here, not two: the trusted-proxy fix appends
   * the socket peer, so the walk strips loopback and then `10.0.0.9`, both
   * declared, and stops on the client. That is the same answer for the same
   * reason, now with the hop the request actually came from proved rather than assumed.
   */
  it('strips a forwarded chain to the client when the last hop is trusted', async () => {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-forwarded-for', `${FORWARDED_CLIENT}, 10.0.0.9`)
      .send(owner);
    expect(res.status).toBe(200);

    expect(await newestSessionAddress()).toBe(FORWARDED_CLIENT);
  });

  /**
   * The reason `TRUST_PROXY` is a key with a safe default rather than a
   * hardcoded `true`: a caller who prepends an address of their choosing does
   * not get it recorded. `getIPFromHeader` strips from the right only while the
   * hops are trusted and stops at the first that is not, so what lands in the
   * column is the rightmost hop that is not a declared proxy — never the claim
   * standing to its left.
   */
  it('refuses to believe an address an untrusted hop claims', async () => {
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .set('x-forwarded-for', `${FORWARDED_CLIENT}, 198.51.100.9`)
      .send(owner);
    expect(res.status).toBe(200);

    const recorded = await newestSessionAddress();
    expect(recorded).toBe('198.51.100.9');
    expect(recorded).not.toBe(FORWARDED_CLIENT);
  });
});
