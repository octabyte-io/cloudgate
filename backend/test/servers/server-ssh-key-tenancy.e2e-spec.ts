import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { server as serverTable } from '../../src/db/schema';
import { SERVER_KEY_PROVIDER } from '../../src/remote/server-key.provider';
import type { ServerKeyProvider } from '../../src/remote/server-key.provider';
import {
  FOREIGN_KEY_MESSAGE,
  NO_KEY_MESSAGE,
} from '../../src/servers/server-connection.provider';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';

jest.setTimeout(120_000);

const instanceOwner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** An id shaped like an SSH key id and naming nothing anywhere. */
const NOWHERE = 'no-such-ssh-key-id';

/** Every field of an error body except the wall clock. */
function withoutTimestamp(body: unknown): unknown {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.timestamp;
  return rest;
}

/**
 * `sshKeyId` as a cross-tenant *credential* reference, on both writers and at
 * the gate that uses the key.
 *
 * `ServersService.create` pinned `organizationId` from the session correctly;
 * the hole was the other id in the same body. `createServerSchema` makes
 * `sshKeyId` required, nothing resolved it, and `server.ssh_key_id → ssh_key`
 * requires only that the key *exist* — so an owner of organization A could
 * create a Server in their own organization pointing at organization B's key,
 * and `ServerConnectionProvider`'s `leftJoin` (which carried no organization
 * predicate either) then handed that private key to every connection.
 * `UpdateServerDto`'s optional `sshKeyId` was the same hole one PATCH later.
 * What that yields is not the plaintext but the **use** of the key: a signing
 * oracle for a credential the caller was never granted, against any host that
 * trusts it.
 *
 * **Why a sibling of `create-routes-server-id.e2e-spec.ts` rather than a row
 * in its table.** The original report names that file as the cheapest home and it is the
 * right instinct — it is this exact sweep for `serverId` — but its table is
 * *nine create routes × one id*, and none of the three obligations here fits a
 * row in it. `POST /servers` is not one of the nine and takes no `serverId`;
 * half of this defect is a **PATCH**, which that table has no column for; and
 * the assertion that actually proves the provider's join — a row that already
 * points at a foreign key — is not an HTTP create at all. It also needs a
 * second *account*, which that file's `insertForeignServer` explicitly cannot
 * spell: it builds its second organization out of the same user, whose grants
 * travel with them. So this follows `test/environments/environment-tenancy.e2e-spec.ts`
 * instead, which is the established shape for exactly this claim, down to
 * `secondOrganizationOwner` and the field-by-field body comparison.
 *
 * **The pair is the point, not the 404.** §2.2 and ADR-0008 require that a
 * refusal disclose nothing about which ids exist elsewhere on the instance, so
 * each direction asserts the foreign-key body against the nothing-anywhere
 * body field by field. A 404 saying *"SSH key not found"* beside a 404 saying
 * *"that key is in another organization"* would pass a status check and be the
 * oracle ADR-0008 names.
 *
 * Before the fix, every refusal below read **201** (or **200** for the PATCH)
 * with the foreign `sshKeyId` on the stored row, and the provider test handed
 * back organization B's private key.
 */
describe('Server SSH key tenancy (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  /**
   * An SSH key in each of two organizations, owned by two separate accounts.
   *
   * The generate path of `POST /ssh-keys` is the one response that carries a
   * private half (`SshKeysService.create`'s documented exception), which is
   * what lets the control below compare the connection's key against the one
   * that was minted without ever asking the database for it.
   */
  async function setUpTwoOrganizations() {
    const signUp = await request(http)
      .post('/api/auth/sign-up/email')
      .send(instanceOwner);
    expect(signUp.status).toBe(200);
    const ownerCookie: string = signUp.headers['set-cookie'];

    const mallory = await secondOrganizationOwner(http, ctx.db, ownerCookie, {
      organizationName: 'Neighbour Org',
    });

    const ours = await request(http)
      .post('/ssh-keys')
      .set('Cookie', ownerCookie)
      .send({ name: 'our-key', type: 'ed25519' });
    expect(ours.status).toBe(201);

    const theirs = await request(http)
      .post('/ssh-keys')
      .set('Cookie', mallory.cookie)
      .send({ name: 'their-key', type: 'ed25519' });
    expect(theirs.status).toBe(201);

    const ourKey = ours.body as { sshKeyId: string; privateKey: string };
    const theirKey = theirs.body as { sshKeyId: string; privateKey: string };
    // Both halves really were minted — asserted as a boolean rather than a
    // value, because a failing `expect` prints what it received and no
    // private key belongs in test output.
    expect(ourKey.privateKey.length > 0).toBe(true);
    expect(theirKey.privateKey.length > 0).toBe(true);

    return {
      ownerCookie,
      mallory,
      ourOrganizationId: mallory.instanceOrganizationId,
      ourKey,
      theirKey,
    };
  }

  const createServer = (cookie: string, sshKeyId: string) =>
    request(http).post('/servers').set('Cookie', cookie).send({
      name: 'edge-1',
      ipAddress: '203.0.113.31',
      port: 22,
      username: 'root',
      sshKeyId,
    });

  /** Every `server` row on the instance, whoever created it. */
  const allServers = () => ctx.db.select().from(serverTable);

  describe('POST /servers', () => {
    it("refuses another organization's SSH key, identically to a key id that exists nowhere", async () => {
      const { ownerCookie, theirKey } = await setUpTwoOrganizations();

      const foreign = await createServer(ownerCookie, theirKey.sshKeyId);
      const absent = await createServer(ownerCookie, NOWHERE);

      expect(foreign.status).toBe(404);
      expect(withoutTimestamp(foreign.body)).toEqual(
        withoutTimestamp(absent.body),
      );
      expect(foreign.body).toMatchObject({ message: 'SSH key not found' });
      // Nothing was written on the way to being refused. The pre-fix
      // behaviour was a *successful* insert, so a fix that inserted and then
      // rolled back would also answer 404 — read the table back.
      expect(await allServers()).toEqual([]);
    });

    it("refuses another organization's owner an SSH key of ours, identically to a key id that exists nowhere", async () => {
      const { mallory, ourKey } = await setUpTwoOrganizations();

      const foreign = await createServer(mallory.cookie, ourKey.sshKeyId);
      const absent = await createServer(mallory.cookie, NOWHERE);

      expect(foreign.status).toBe(404);
      expect(withoutTimestamp(foreign.body)).toEqual(
        withoutTimestamp(absent.body),
      );
      expect(foreign.body).toMatchObject({ message: 'SSH key not found' });
      expect(await allServers()).toEqual([]);
    });

    it("creates a Server against the caller's own SSH key", async () => {
      const { ownerCookie, ourKey } = await setUpTwoOrganizations();

      const created = await createServer(ownerCookie, ourKey.sshKeyId);

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        name: 'edge-1',
        sshKeyId: ourKey.sshKeyId,
      });
    });
  });

  describe('PATCH /servers/:id', () => {
    it("refuses repointing a Server at another organization's SSH key, identically to a key id that exists nowhere", async () => {
      const { ownerCookie, ourKey, theirKey } = await setUpTwoOrganizations();
      const created = await createServer(ownerCookie, ourKey.sshKeyId);
      expect(created.status).toBe(201);
      const serverId = (created.body as { serverId: string }).serverId;

      const patch = (sshKeyId: string) =>
        request(http)
          .patch(`/servers/${serverId}`)
          .set('Cookie', ownerCookie)
          .send({ sshKeyId });

      const foreign = await patch(theirKey.sshKeyId);
      const absent = await patch(NOWHERE);

      expect(foreign.status).toBe(404);
      expect(withoutTimestamp(foreign.body)).toEqual(
        withoutTimestamp(absent.body),
      );
      expect(foreign.body).toMatchObject({ message: 'SSH key not found' });
      // The stored row still points where it did — before the fix this PATCH
      // answered 200 with the neighbour's key on it.
      const rows = await allServers();
      expect(rows.map((row) => row.sshKeyId)).toEqual([ourKey.sshKeyId]);
    });

    it("still updates a Server's other fields, and its key within its own organization", async () => {
      const { ownerCookie, ourKey } = await setUpTwoOrganizations();
      const created = await createServer(ownerCookie, ourKey.sshKeyId);
      const serverId = (created.body as { serverId: string }).serverId;

      // A PATCH that never mentions `sshKeyId` must not have to resolve one,
      // and one that names the caller's own key must still land.
      const renamed = await request(http)
        .patch(`/servers/${serverId}`)
        .set('Cookie', ownerCookie)
        .send({ description: 'renamed' });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        description: 'renamed',
        sshKeyId: ourKey.sshKeyId,
      });

      const rekeyed = await request(http)
        .patch(`/servers/${serverId}`)
        .set('Cookie', ownerCookie)
        .send({ sshKeyId: ourKey.sshKeyId });
      expect(rekeyed.status).toBe(200);
      expect(rekeyed.body).toMatchObject({ sshKeyId: ourKey.sshKeyId });
    });
  });

  /**
   * The half of the report that no create-route assertion can reach: a `server` row
   * that **already** points at a foreign key. It is written straight to the
   * table, because after the fix above the API will not make one — which is
   * exactly why the provider's own predicate is not redundant. It is the last
   * gate before a private key is decrypted and used, and `RemoteExecService`
   * and `RemoteDockerFactory` reach it from below the permission layer with
   * nothing but a `serverId`.
   */
  describe('SERVER_KEY_PROVIDER', () => {
    const provider = () => ctx.app.get<ServerKeyProvider>(SERVER_KEY_PROVIDER);

    async function insertServer(
      organizationId: string,
      sshKeyId: string | null,
    ) {
      const [row] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'pre-existing',
          ipAddress: '203.0.113.77',
          port: 22,
          username: 'deploy',
          organizationId,
          sshKeyId,
        })
        .returning();
      return row;
    }

    it('refuses a Server whose SSH key is in another organization, and does not confuse it with a Server that has no key', async () => {
      const { ourOrganizationId, theirKey } = await setUpTwoOrganizations();
      const foreignKeyed = await insertServer(
        ourOrganizationId,
        theirKey.sshKeyId,
      );
      const keyless = await insertServer(ourOrganizationId, null);

      // Before the fix this resolved and returned the neighbour's private
      // key. `rejects.toThrow` never prints the value it did not get.
      await expect(
        provider().getConnection(foreignKeyed.serverId),
      ).rejects.toThrow(FOREIGN_KEY_MESSAGE);
      // And the broken row is not described as the merely-unconfigured one:
      // its `ssh_key_id` is populated, and an operator told "no SSH key
      // assigned" would go looking for a bug in the column.
      await expect(provider().getConnection(keyless.serverId)).rejects.toThrow(
        NO_KEY_MESSAGE,
      );
      expect(FOREIGN_KEY_MESSAGE).not.toBe(NO_KEY_MESSAGE);
    });

    it("hands back the private key of a Server pointing at its own organization's key", async () => {
      const { ourOrganizationId, ourKey } = await setUpTwoOrganizations();
      const own = await insertServer(ourOrganizationId, ourKey.sshKeyId);

      const connection = await provider().getConnection(own.serverId);

      expect(connection).toMatchObject({
        host: '203.0.113.77',
        port: 22,
        username: 'deploy',
      });
      // The control that keeps the new join predicate honest: a predicate
      // that never matched would make every assertion above pass. Compared as
      // a boolean so a failure prints `false` rather than the key.
      expect(connection.privateKey === ourKey.privateKey).toBe(true);
    });

    it('refuses a Server whose key was deleted out from under it', async () => {
      const { ownerCookie, ourKey } = await setUpTwoOrganizations();
      const created = await createServer(ownerCookie, ourKey.sshKeyId);
      const serverId = (created.body as { serverId: string }).serverId;

      const removed = await request(http)
        .delete(`/ssh-keys/${ourKey.sshKeyId}`)
        .set('Cookie', ownerCookie);
      expect(removed.status).toBe(200);

      // `server.sshKeyId` is `on delete set null`, so this lands on the
      // no-key branch rather than the new one — the state the pre-fix
      // message was written for, unchanged.
      const rows = await ctx.db
        .select()
        .from(serverTable)
        .where(eq(serverTable.serverId, serverId));
      expect(rows[0].sshKeyId).toBeNull();
      await expect(provider().getConnection(serverId)).rejects.toThrow(
        NO_KEY_MESSAGE,
      );
    });
  });
});
