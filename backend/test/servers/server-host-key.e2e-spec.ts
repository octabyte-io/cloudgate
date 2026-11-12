import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { server as serverTable, sshKey } from '../../src/db/schema';
import { HOST_KEY_CHANGED_CODE } from '../../src/remote/host-key';
import { stackVmPublicKey } from '../../src/stack-vm/stack-vm-key';
import { startSshForwardServer } from '../utils/ssh-forward-server';
import type { SshForwardServer } from '../utils/ssh-forward-server';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner, signUpMember } from '../utils/test-auth';

jest.setTimeout(120_000);

/** A fingerprint no key in this suite has. */
const OTHER_FINGERPRINT = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/**
 * Trust on first use of a Server's SSH host key (ADR-0074), end to end: a
 * real SSH server stands in for the Server, and the real provider and
 * `RemoteExecService` dial it, so what is recorded is what the handshake saw.
 */
describe('Server host key (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let sshd: SshForwardServer;

  beforeAll(async () => {
    sshd = await startSshForwardServer();
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    await sshd.close();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    sshd.execs.length = 0;
    sshd.execAnswer = () => ({ stdout: 'ok\n', code: 0 });
  });

  /** The owner, and a Server whose address is the stand-in sshd. */
  async function setUp() {
    const signUp = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    const cookie = signUp.headers['set-cookie'];
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const [key] = await ctx.db
      .insert(sshKey)
      .values({
        name: 'deploy-key',
        organizationId,
        privateKey: sshd.connection.privateKey,
        publicKey: stackVmPublicKey(sshd.connection.privateKey),
      })
      .returning();
    const created = await request(http)
      .post('/servers')
      .set('Cookie', cookie)
      .send({
        name: 'web-1',
        ipAddress: sshd.connection.host,
        port: sshd.connection.port,
        username: sshd.connection.username,
        sshKeyId: key.sshKeyId,
      });
    expect(created.status).toBe(201);
    const { serverId } = created.body as { serverId: string };
    return { cookie, serverId };
  }

  const recorded = async (serverId: string) => {
    const [row] = await ctx.db
      .select({ fingerprint: serverTable.hostKeyFingerprint })
      .from(serverTable)
      .where(eq(serverTable.serverId, serverId));
    return row.fingerprint;
  };

  it('records the host key on first connect and answers it on the Server', async () => {
    const { cookie, serverId } = await setUp();

    const before = await request(http)
      .get(`/servers/${serverId}`)
      .set('Cookie', cookie);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ hostKeyFingerprint: null });

    const check = await request(http)
      .get(`/servers/${serverId}/validate`)
      .set('Cookie', cookie);
    expect(check.status).toBe(200);

    const after = await request(http)
      .get(`/servers/${serverId}`)
      .set('Cookie', cookie);
    expect(after.body).toMatchObject({
      hostKeyFingerprint: sshd.hostKeyFingerprint,
    });
    const list = await request(http).get('/servers').set('Cookie', cookie);
    expect(list.body).toEqual([
      expect.objectContaining({ hostKeyFingerprint: sshd.hostKeyFingerprint }),
    ]);
  });

  it('connects again when the Server presents the recorded host key', async () => {
    const { cookie, serverId } = await setUp();
    await ctx.db
      .update(serverTable)
      .set({ hostKeyFingerprint: sshd.hostKeyFingerprint })
      .where(eq(serverTable.serverId, serverId));

    const check = await request(http)
      .get(`/servers/${serverId}/validate`)
      .set('Cookie', cookie);
    expect(check.status).toBe(200);
    expect(sshd.execs).toEqual(['echo ok']);
  });

  it('refuses a changed host key with 409, naming both fingerprints, and runs nothing', async () => {
    const { cookie, serverId } = await setUp();
    await ctx.db
      .update(serverTable)
      .set({ hostKeyFingerprint: OTHER_FINGERPRINT })
      .where(eq(serverTable.serverId, serverId));

    const check = await request(http)
      .get(`/servers/${serverId}/validate`)
      .set('Cookie', cookie);

    expect(check.status).toBe(409);
    const body = check.body as { code: string; message: string };
    expect(body.code).toBe(HOST_KEY_CHANGED_CODE);
    expect(body.message).toContain('web-1');
    expect(body.message).toContain(OTHER_FINGERPRINT);
    expect(body.message).toContain(sshd.hostKeyFingerprint);
    expect(sshd.execs).toEqual([]);
    expect(await recorded(serverId)).toBe(OTHER_FINGERPRINT);
    // The refusal is the stored reach answer every Server tab reads.
    const row = await request(http)
      .get(`/servers/${serverId}`)
      .set('Cookie', cookie);
    expect(row.body).toMatchObject({ reachOk: false });
    expect((row.body as { reachMessage: string }).reachMessage).toContain(
      OTHER_FINGERPRINT,
    );
  });

  it('forgets the recorded host key, after which the next connect records the new one', async () => {
    const { cookie, serverId } = await setUp();
    await ctx.db
      .update(serverTable)
      .set({ hostKeyFingerprint: OTHER_FINGERPRINT })
      .where(eq(serverTable.serverId, serverId));

    const forgotten = await request(http)
      .post(`/servers/${serverId}/forget-host-key`)
      .set('Cookie', cookie);
    expect(forgotten.status).toBe(200);
    expect(forgotten.body).toMatchObject({
      serverId,
      hostKeyFingerprint: null,
    });

    const check = await request(http)
      .get(`/servers/${serverId}/validate`)
      .set('Cookie', cookie);
    expect(check.status).toBe(200);
    expect(await recorded(serverId)).toBe(sshd.hostKeyFingerprint);
  });

  it('forgets the recorded host key when the Server is pointed at a new address', async () => {
    const { cookie, serverId } = await setUp();
    await ctx.db
      .update(serverTable)
      .set({ hostKeyFingerprint: OTHER_FINGERPRINT })
      .where(eq(serverTable.serverId, serverId));

    const renamed = await request(http)
      .patch(`/servers/${serverId}`)
      .set('Cookie', cookie)
      .send({ name: 'web-1-renamed' });
    expect(renamed.status).toBe(200);
    expect(await recorded(serverId)).toBe(OTHER_FINGERPRINT);

    const moved = await request(http)
      .patch(`/servers/${serverId}`)
      .set('Cookie', cookie)
      .send({ port: sshd.connection.port + 1 });
    expect(moved.status).toBe(200);
    expect(await recorded(serverId)).toBeNull();
  });

  it('refuses Forget host key to a member whose role cannot change Servers', async () => {
    const { cookie, serverId } = await setUp();
    await ctx.db
      .update(serverTable)
      .set({ hostKeyFingerprint: OTHER_FINGERPRINT })
      .where(eq(serverTable.serverId, serverId));
    const member = await signUpMember(http, cookie);

    const refused = await request(http)
      .post(`/servers/${serverId}/forget-host-key`)
      .set('Cookie', member.cookie);

    expect(refused.status).toBe(403);
    expect(await recorded(serverId)).toBe(OTHER_FINGERPRINT);
  });

  it('answers 404 to another organization’s owner and leaves the host key alone', async () => {
    const { cookie, serverId } = await setUp();
    await ctx.db
      .update(serverTable)
      .set({ hostKeyFingerprint: OTHER_FINGERPRINT })
      .where(eq(serverTable.serverId, serverId));
    const mallory = await secondOrganizationOwner(http, ctx.db, cookie);

    const answered = await request(http)
      .post(`/servers/${serverId}/forget-host-key`)
      .set('Cookie', mallory.cookie);

    expect(answered.status).toBe(404);
    expect(await recorded(serverId)).toBe(OTHER_FINGERPRINT);
  });
});
