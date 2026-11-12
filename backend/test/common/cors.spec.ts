import { Controller, Get, INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { corsOptions, corsPolicy } from '../../src/common/config/cors';
import { validateEnv } from '../../src/common/config/env.schema';

@Controller('cors-probe')
class CorsProbeController {
  @Get()
  read() {
    return { ok: true };
  }
}

/** Stands in for the Trace store proxy's frame route (ADR-0075). */
@Controller('traces')
class FrameProbeController {
  @Get(':serviceId/ui/t/:token/api/services')
  read() {
    return { ok: true };
  }

  @Get(':serviceId/frame')
  frame() {
    return { ok: true };
  }
}

/**
 * main.ts used to call enableCors() bare, which answers every request with
 * `Access-Control-Allow-Origin: *` and no `Access-Control-Allow-Credentials`.
 * A browser refuses that pairing on a credentialed request, and the session is
 * a cookie, so no cross-origin browser client could call the API at all while
 * the wildcard advertised that any origin could.
 *
 * These boot the same options main.ts installs, over a probe route, and read
 * the headers a browser would.
 */
async function startApp(allowedOrigins: string[]): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    controllers: [CorsProbeController],
  }).compile();
  const app = moduleRef.createNestApplication();
  app.enableCors(corsOptions(allowedOrigins));
  await app.init();
  return app;
}

const ALLOWED = 'https://console.example.com';

describe('CORS', () => {
  // main.ts reads the allowlist off ConfigService, so it has to come back as
  // the schema's parsed array and not as the raw comma-separated string.
  describe('the allowlist main.ts reads', () => {
    // validateEnv runs over process.env, so the value has to be set there —
    // a `load` factory is applied after validation and would prove nothing.
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = {
        NODE_ENV: 'test',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/cloudgate',
        APP_ENCRYPTION_SECRET: 'a-long-enough-secret-value-123456',
        BETTER_AUTH_SECRET: 'another-long-enough-secret-value-42',
      };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    async function loadConfig(): Promise<ConfigService> {
      const moduleRef = await Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ ignoreEnvFile: true, validate: validateEnv }),
        ],
      }).compile();
      return moduleRef.get(ConfigService);
    }

    it('arrives as a parsed list of origins', async () => {
      process.env.CORS_ALLOWED_ORIGINS = `${ALLOWED}, http://localhost:3000`;
      const config = await loadConfig();

      expect(config.get<string[]>('CORS_ALLOWED_ORIGINS', [])).toEqual([
        ALLOWED,
        'http://localhost:3000',
      ]);
    });

    it('arrives empty when nothing sets it', async () => {
      const config = await loadConfig();

      expect(config.get<string[]>('CORS_ALLOWED_ORIGINS', [])).toEqual([]);
    });
  });

  describe('with an allowlist naming the origin', () => {
    let app: INestApplication;
    let server: App;

    beforeAll(async () => {
      app = await startApp([ALLOWED, 'http://localhost:3000']);
      server = app.getHttpServer() as App;
    });

    afterAll(async () => {
      await app.close();
    });

    it('answers a preflight by echoing the origin and allowing credentials', async () => {
      const res = await request(server)
        .options('/cors-probe')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'GET');

      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('varies on Origin, so a shared cache cannot serve one origin its neighbour headers', async () => {
      const res = await request(server)
        .options('/cors-probe')
        .set('Origin', ALLOWED)
        .set('Access-Control-Request-Method', 'GET');

      expect(res.headers['vary']).toMatch(/Origin/);
    });

    it('repeats the origin and credentials on the actual response', async () => {
      const res = await request(server)
        .get('/cors-probe')
        .set('Origin', ALLOWED);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(ALLOWED);
      expect(res.headers['access-control-allow-credentials']).toBe('true');
    });

    it('never answers with a wildcard, which a credentialed request cannot use', async () => {
      const res = await request(server)
        .get('/cors-probe')
        .set('Origin', ALLOWED);

      expect(res.headers['access-control-allow-origin']).not.toBe('*');
    });

    it('sends no allow-origin to an origin that is not on the list', async () => {
      const res = await request(server)
        .get('/cors-probe')
        .set('Origin', 'https://not-allowed.example.com');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('refuses a preflight from an origin that is not on the list', async () => {
      const res = await request(server)
        .options('/cors-probe')
        .set('Origin', 'https://not-allowed.example.com')
        .set('Access-Control-Request-Method', 'GET');

      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still serves a request with no Origin at all, since CORS does not apply to it', async () => {
      const res = await request(server).get('/cors-probe');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });

  describe('with an empty allowlist (the default)', () => {
    let app: INestApplication;
    let server: App;

    beforeAll(async () => {
      app = await startApp([]);
      server = app.getHttpServer() as App;
    });

    afterAll(async () => {
      await app.close();
    });

    it('allows no cross-origin browser client rather than falling back to a wildcard', async () => {
      const res = await request(server)
        .get('/cors-probe')
        .set('Origin', ALLOWED);

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('still serves a same-origin or non-browser request', async () => {
      const res = await request(server).get('/cors-probe');

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });
  });

  /**
   * The installed policy, `corsPolicy`: the allowlist above everywhere but a
   * Trace store frame's path, whose requests come from a sandboxed frame's
   * opaque origin (`Origin: null`) and are authorized by the token in that
   * path, never by a cookie.
   */
  describe('as installed, with its Trace store frame carve-out', () => {
    let app: INestApplication;
    let server: App;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({
        controllers: [CorsProbeController, FrameProbeController],
      }).compile();
      app = moduleRef.createNestApplication();
      app.enableCors(corsPolicy([ALLOWED]));
      await app.init();
      server = app.getHttpServer() as App;
    });

    afterAll(async () => {
      await app.close();
    });

    const FRAME = '/traces/app-1/ui/t/tok.sig/api/services';

    it('answers a frame’s preflight from the opaque origin, with the verbs the proxy forwards and no credentials', async () => {
      const res = await request(server)
        .options(FRAME)
        .set('Origin', 'null')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type');

      expect(res.status).toBeLessThan(300);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
      expect(res.headers['access-control-allow-methods']).toBe('GET,HEAD,POST');
      expect(res.headers['access-control-allow-headers']).toBe('content-type');
    });

    it('answers a frame’s request to any origin, never with credentials', async () => {
      const res = await request(server).get(FRAME).set('Origin', 'null');

      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('keeps the allowlist on every other path, the frame token’s own mint included', async () => {
      for (const path of ['/cors-probe', '/traces/app-1/frame']) {
        const refused = await request(server).get(path).set('Origin', 'null');
        expect(refused.headers['access-control-allow-origin']).toBeUndefined();

        const allowed = await request(server).get(path).set('Origin', ALLOWED);
        expect(allowed.headers['access-control-allow-origin']).toBe(ALLOWED);
        expect(allowed.headers['access-control-allow-credentials']).toBe(
          'true',
        );
      }
    });
  });
});
