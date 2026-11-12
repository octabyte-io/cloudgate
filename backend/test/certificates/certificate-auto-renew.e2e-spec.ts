import request from 'supertest';
import { App } from 'supertest/types';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { TraefikWriterService } from '../../src/traefik/traefik-writer.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const selfSigned = {
  name: 'wildcard-example-com',
  certificateData:
    '-----BEGIN CERTIFICATE-----\nMIIBszCCAVo=\n-----END CERTIFICATE-----',
  privateKey:
    '-----BEGIN PRIVATE KEY-----\nMIGHAgEAMBM=\n-----END PRIVATE KEY-----',
};

/**
 * A certificate is material somebody pasted in; renewing it means pasting the
 * next one. Nothing in the backend ever renewed anything, so `autoRenew` is
 * gone from the table and from the create DTO
 * These tests pin
 * the observable consequence at the HTTP seam: an older client that still
 * sends the flag is not broken by its removal, and no response carries it.
 */
describe('Certificates without autoRenew (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  const traefikWriterMock = {
    loadOrCreateConfig: jest.fn(),
    writeConfig: jest.fn(),
    removeConfig: jest.fn(),
    writeCertificate: jest.fn(),
    removeCertificate: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: RemoteExecService, useValue: execMock },
        { provide: TraefikWriterService, useValue: traefikWriterMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    jest.clearAllMocks();

    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(signUp.status).toBe(200);
    cookie = signUp.headers['set-cookie'];
  });

  it('accepts a create that still sends autoRenew, and neither persists nor echoes it', async () => {
    const created = await request(server)
      .post('/certificates')
      .set('Cookie', cookie)
      .send({ ...selfSigned, autoRenew: true });

    // The flag is an unknown key to the create schema, so it is stripped
    // rather than rejected: an old client keeps working.
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('autoRenew');

    const { certificateId } = created.body as { certificateId: string };

    const one = await request(server)
      .get(`/certificates/${certificateId}`)
      .set('Cookie', cookie);
    expect(one.status).toBe(200);
    expect(one.body).not.toHaveProperty('autoRenew');

    const listed = await request(server)
      .get('/certificates')
      .set('Cookie', cookie);
    expect(listed.status).toBe(200);
    expect((listed.body as object[])[0]).not.toHaveProperty('autoRenew');
  });

  it('has no auto_renew column left on the certificate table', async () => {
    const columns = await ctx.db.$client.query<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'certificate'",
    );
    expect(columns.rows.map((r) => r.column_name)).not.toContain('auto_renew');
  });

  it('ignores autoRenew on update too, leaving the rest of the row intact', async () => {
    const created = await request(server)
      .post('/certificates')
      .set('Cookie', cookie)
      .send(selfSigned);
    expect(created.status).toBe(201);
    const { certificateId } = created.body as { certificateId: string };

    const patched = await request(server)
      .patch(`/certificates/${certificateId}`)
      .set('Cookie', cookie)
      .send({ name: 'renamed', autoRenew: true });

    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ name: 'renamed' });
    expect(patched.body).not.toHaveProperty('autoRenew');
  });
});
