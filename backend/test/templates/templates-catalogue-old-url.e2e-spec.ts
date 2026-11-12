import { Logger } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * An install that still sets the `template.toml` reader's
 * `CLOUDGATE_TEMPLATES_BASE_URL` and not `CLOUDGATE_TEMPLATES_URL`
 * (ADR-0066): it starts, templates are off rather than pointed at GitHub, and
 * the startup log and the templates screen say what to set.
 *
 * Set at module scope, before `createTestApp` requires `AppModule`, because
 * `ConfigModule.forRoot({ validate })` snapshots `process.env` on that first
 * import; restored in `afterAll`.
 */
const urlBefore = process.env.CLOUDGATE_TEMPLATES_URL;
const oldUrlBefore = process.env.CLOUDGATE_TEMPLATES_BASE_URL;
delete process.env.CLOUDGATE_TEMPLATES_URL;
process.env.CLOUDGATE_TEMPLATES_BASE_URL = 'https://mirror.example.internal/';

/** ADR-0066's sentence, written out rather than imported (§1.7). */
const ADR_0066_MESSAGE =
  '`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read. Set `CLOUDGATE_TEMPLATES_URL`, or remove the old setting to use the official catalogue.';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

describe('Templates on an install keeping the old setting (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string[];
  const fetchClient = jest.fn();
  const warned = jest.spyOn(Logger.prototype, 'warn');

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
    warned.mockRestore();
    await ctx.teardown();
    if (urlBefore !== undefined)
      process.env.CLOUDGATE_TEMPLATES_URL = urlBefore;
    if (oldUrlBefore === undefined)
      delete process.env.CLOUDGATE_TEMPLATES_BASE_URL;
    else process.env.CLOUDGATE_TEMPLATES_BASE_URL = oldUrlBefore;
  });

  it('says what to set in the startup log', () => {
    expect(warned).toHaveBeenCalledWith(ADR_0066_MESSAGE);
  });

  it.each(['/templates', '/templates/tags'])(
    'GET %s answers the coded 503 with the same sentence, and fetches nothing',
    async (path) => {
      const res = await request(server).get(path).set('Cookie', cookie);

      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        message: ADR_0066_MESSAGE,
        code: 'TEMPLATES_CATALOGUE_NOT_CONFIGURED',
      });
      expect(fetchClient).not.toHaveBeenCalled();
    },
  );
});
