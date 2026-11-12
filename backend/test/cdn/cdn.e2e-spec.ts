import request from 'supertest';
import { App } from 'supertest/types';
import { DNS_RESOLVER } from '../../src/cdn/cdn.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

describe('CDN (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  const resolverMock = jest.fn<Promise<string[]>, [string]>();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: DNS_RESOLVER, useValue: resolverMock }],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    resolverMock.mockReset();
  });

  async function signUpOwner(): Promise<string> {
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  }

  it('validates a domain through the controller, surfacing CDN detection', async () => {
    const cookie = await signUpOwner();
    resolverMock.mockResolvedValue(['104.16.132.229']);

    const behindCdn = await request(server)
      .post('/domains/validate')
      .set('Cookie', cookie)
      .send({ domain: 'app.example.com' });
    expect(behindCdn.status).toBe(200);
    expect(behindCdn.body).toEqual({
      isValid: true,
      resolvedIp: '104.16.132.229',
      cdnProvider: 'Cloudflare',
      error:
        'Domain is behind Cloudflare - actual IP is masked by Cloudflare proxy',
    });

    resolverMock.mockResolvedValue(['203.0.113.7']);
    const mismatch = await request(server)
      .post('/domains/validate')
      .set('Cookie', cookie)
      .send({ domain: 'app.example.com', serverIp: '198.51.100.1' });
    expect(mismatch.status).toBe(200);
    expect(mismatch.body).toEqual({
      isValid: false,
      resolvedIp: '203.0.113.7',
      error: 'Domain resolves to 203.0.113.7 but should point to 198.51.100.1',
    });

    const invalid = await request(server)
      .post('/domains/validate')
      .set('Cookie', cookie)
      .send({});
    expect(invalid.status).toBe(400);

    const anonymous = await request(server)
      .post('/domains/validate')
      .send({ domain: 'app.example.com' });
    expect(anonymous.status).toBe(401);
  });
});
