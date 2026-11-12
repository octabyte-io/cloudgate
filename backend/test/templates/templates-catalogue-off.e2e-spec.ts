import request from 'supertest';
import { App } from 'supertest/types';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * `CLOUDGATE_TEMPLATES_URL=off` (ADR-0062): templates are off, both catalogue
 * routes answer the coded 503 saying so, and nothing is fetched. The old
 * setting is set too, to show the new one wins over it.
 *
 * Set at module scope, before `createTestApp` requires `AppModule`, because
 * `ConfigModule.forRoot({ validate })` snapshots `process.env` on that first
 * import; restored in `afterAll`.
 */
const urlBefore = process.env.CLOUDGATE_TEMPLATES_URL;
const oldUrlBefore = process.env.CLOUDGATE_TEMPLATES_BASE_URL;
process.env.CLOUDGATE_TEMPLATES_URL = 'off';
process.env.CLOUDGATE_TEMPLATES_BASE_URL = 'https://mirror.example.internal';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

describe('Templates turned off (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string[];
  const fetchClient = jest.fn();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: FETCH_CLIENT, useValue: fetchClient },
        {
          provide: RemoteExecService,
          useValue: { execAsync: jest.fn(), execAsyncRemote: jest.fn() },
        },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = res.headers['set-cookie'] as unknown as string[];
  });

  afterAll(async () => {
    await ctx.teardown();
    if (urlBefore === undefined) delete process.env.CLOUDGATE_TEMPLATES_URL;
    else process.env.CLOUDGATE_TEMPLATES_URL = urlBefore;
    if (oldUrlBefore === undefined)
      delete process.env.CLOUDGATE_TEMPLATES_BASE_URL;
    else process.env.CLOUDGATE_TEMPLATES_BASE_URL = oldUrlBefore;
  });

  it.each(['/templates', '/templates/tags'])(
    'GET %s answers the coded 503 saying templates are off, and fetches nothing',
    async (path) => {
      const res = await request(server).get(path).set('Cookie', cookie);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        message:
          'Templates are turned off on this instance: CLOUDGATE_TEMPLATES_URL is off. Remove the setting to use the official catalogue, or set it to the address of a catalogue.zip.',
        code: 'TEMPLATES_CATALOGUE_NOT_CONFIGURED',
      });
      expect(fetchClient).not.toHaveBeenCalled();
    },
  );
});
