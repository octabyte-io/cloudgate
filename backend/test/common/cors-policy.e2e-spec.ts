import { Controller, Get } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { Public } from '../../src/auth/decorators/public.decorator';
import { applyCors } from '../../src/common/config/cors';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const ALLOWED = 'https://console.example.com';
const REFUSED = 'https://attacker.example.com';

// ConfigModule snapshots process.env when app.module is first imported, and
// `createTestApp` requires it lazily for exactly that reason — so the allowlist
// has to be in the environment before the first `createTestApp` call, not
// handed to a `load` factory that runs after validation.
process.env.CORS_ALLOWED_ORIGINS = `${ALLOWED}, http://localhost:3000`;

@Public()
@Controller('cors-e2e-public')
class PublicProbeController {
  @Get()
  read() {
    return { ok: true };
  }
}

@Controller('cors-e2e-guarded')
class GuardedProbeController {
  @Get()
  read() {
    return { ok: true };
  }
}

/**
 * H-42: the CORS decision, met by a request, on the app `main.ts` builds.
 *
 * `test/common/cors.spec.ts` has covered the *options object* — over
 * a two-route module it boots itself, with `app.enableCors(corsOptions([…]))`
 * written out by hand. What it cannot cover is the arrangement: that the
 * allowlist is read off `CORS_ALLOWED_ORIGINS`, that the policy is installed on
 * the real application, and that it sits in front of the global `AuthGuard`,
 * the exception filter and the auth catch-all rather than beside them.
 * `createTestApp` reproduced none of it, so nothing in 89 e2e files had ever
 * sent a request that met the policy — and the first assertion of a
 * cross-origin refusal to be written would have passed against an app with no
 * policy at all, which answers every origin and refuses none. That is H-28's
 * failure mode exactly, one step before it happens.
 *
 * Wired through `beforeInit: applyCors` — the same function `main.ts` calls,
 * in the shape `docs-route.e2e-spec.ts` uses for `mountOpenApiDocument`. Opt-in
 * rather than on by default because turning the policy on for every e2e changes
 * what a credentialed request with no `Origin` does, which is most of them.
 */
describe('the CORS policy answers named origins and refuses the rest', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      controllers: [PublicProbeController, GuardedProbeController],
      beforeInit: applyCors,
    });
    server = ctx.app.getHttpServer() as App;
    const signUp = await request(server).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers['set-cookie'];
  }, 120_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  describe('an origin on the allowlist', () => {
    it('is echoed back on a preflight, with credentials allowed', async () => {
      const res = await request(server)
        .options('/cors-e2e-public')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'GET');

      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('is echoed back on the response itself', async () => {
      const res = await request(server)
        .get('/cors-e2e-public')
        .set('Origin', ALLOWED)
        .expect(200);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('varies on Origin, so a shared cache cannot serve one origin its neighbour headers', async () => {
      const res = await request(server)
        .get('/cors-e2e-public')
        .set('Origin', ALLOWED);

      expect(res.headers['vary']).toMatch(/Origin/);
    });

    // The whole point of naming origins instead of taking the wildcard: the
    // session is a cookie, and a browser drops a credentialed response that
    // does not say `Access-Control-Allow-Credentials: true`. This is the one
    // assertion that needs a real session behind it — the route reads the
    // cookie the header is granting permission to send.
    it('carries a session cookie all the way to a route that reads it', async () => {
      const res = await request(server)
        .get('/api/auth/get-session')
        .set('Origin', ALLOWED)
        .set('Cookie', cookie)
        .expect(200);

      expect((res.body as { user: { email: string } }).user.email).toBe(
        'grace@example.com',
      );
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    // CORS is installed on the adapter, ahead of the global AuthGuard, so a
    // refusal is still readable cross-origin. Without the headers a browser
    // reports a network error and the console cannot tell "signed out" from
    // "unreachable" — a 401 nobody can read is a worse answer than a 401.
    it('lets a cross-origin caller read a 401 instead of a network error', async () => {
      const res = await request(server)
        .get('/cors-e2e-guarded')
        .set('Origin', ALLOWED)
        .expect(401);

      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
    });
  });

  describe('an origin that is not on the allowlist', () => {
    it('is refused a preflight', async () => {
      const res = await request(server)
        .options('/cors-e2e-public')
        .set('Origin', REFUSED)
        .set('Access-Control-Request-Method', 'GET');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    // Only the allow-origin is withheld. `Access-Control-Allow-Credentials` is
    // still sent, because the `cors` package emits it from the `credentials`
    // option alone and never conditions it on the origin — and it is inert
    // without an allow-origin beside it, since a browser reads the pair. Pinned
    // rather than left out, because the header being present here looks like
    // the policy leaking and is not.
    it('is refused the response, whatever else the response carries', async () => {
      const res = await request(server)
        .get('/cors-e2e-public')
        .set('Origin', REFUSED);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    // The refusal is the *absence* of the header, so the server still runs the
    // handler and still answers 200 — the browser is what drops it. Asserted so
    // nobody reads a 200 here as the policy having failed, and reads it as what
    // it is: no allow-origin, therefore nothing the caller can see.
    it('is refused by omission rather than by a status code', async () => {
      const res = await request(server)
        .get('/cors-e2e-public')
        .set('Origin', REFUSED);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('is refused a credentialed request even holding a valid session', async () => {
      const res = await request(server)
        .get('/api/auth/get-session')
        .set('Origin', REFUSED)
        .set('Cookie', cookie);

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  // `enableCors()` bare is what the CORS decision replaced, and it answers `*` and no
  // credentials header — a pairing a browser refuses, which is how the wildcard
  // managed to advertise that any origin could call an API no origin could.
  // Checked on every response this suite can produce rather than on one, since
  // a wildcard reintroduced by a later default would show up on whichever path
  // was not pinned.
  it('never answers with a wildcard, which a credentialed request cannot use', async () => {
    for (const origin of [ALLOWED, REFUSED]) {
      const res = await request(server)
        .get('/cors-e2e-public')
        .set('Origin', origin);
      expect(res.headers['access-control-allow-origin']).not.toBe('*');

      const preflight = await request(server)
        .options('/cors-e2e-public')
        .set('Origin', origin)
        .set('Access-Control-Request-Method', 'GET');
      expect(preflight.headers['access-control-allow-origin']).not.toBe('*');
    }
  });

  // The reason the policy is opt-in rather than wired into `createTestApp`:
  // this is what the other 89 files send, and it has to keep meaning what it
  // meant. CORS does not apply to a request with no Origin, so the policy must
  // be invisible to it.
  it('still serves a request with no Origin at all', async () => {
    const res = await request(server).get('/cors-e2e-public').expect(200);

    expect(res.body).toEqual({ ok: true });
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
