// The Hosted instance with both provider tokens. Set before the app module is
// imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { boughtServer } from '../../src/bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../../src/bought-servers/bought-server.schema';
import { labelsOf } from '../../src/bought-servers/bought-server-stages.service';
import { BoughtServersHourly } from '../../src/bought-servers/bought-servers-hourly.service';
import { MailService } from '../../src/mail/mail.service';
import {
  HOSTED_STAFF,
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

interface ListedOrphan {
  providerServerId: number;
  name: string;
  location: string;
  labels: Record<string, string>;
  createdAt: string;
  foundAt: string;
  seenAt: string;
}

interface AuditRow {
  organizationId: string | null;
  userEmail: string | null;
  action: string;
  resourceId: string | null;
  metadata: string | null;
}

const ORPHAN_SUBJECT = /machines? nothing owns (was|were) found/;

/**
 * Machines nothing owns (#1402, spec #1387): the hourly job lists the
 * provider's machines by Cloudgate's labels, emails the Operators once
 * about each with no live Bought Server behind it, and lists it on the
 * Operator page with its labels and age. Only an Operator's Delete removes
 * one, with its Volume and Primary IPs, audited. The provider is the
 * in-memory fake.
 */
describe('Machines nothing owns (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let hourly: BoughtServersHourly;
  let staffCookie: string;
  let instanceOrganizationId: string;
  let grace: HostedCustomer;
  const mail = new MailRecorder();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: MailService, useValue: mail }],
    });
    http = ctx.app.getHttpServer() as App;
    hourly = ctx.app.get(BoughtServersHourly);
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    mail.clear();
    instanceOrganizationId = (await openHostedSignUp(ctx.db)).organizationId;
    staffCookie = await signIn(HOSTED_STAFF.email, HOSTED_STAFF.password);
    grace = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
    mail.clear();
  });

  async function signIn(email: string, password: string): Promise<string> {
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email, password });
    expect(res.status).toBe(200);
    return (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  }

  /** Arrangement only: a machine in the fake account, with these labels. */
  async function givenMachine(
    name: string,
    labels: Record<string, string>,
  ): Promise<number> {
    const made = await ctx.hetzner.machines.createServer({
      name,
      serverType: 'cpx22',
      location: 'hel1',
      image: 'ubuntu-24.04',
      sshPublicKey: 'ssh-ed25519 AAAA test',
      labels,
    });
    if (!made.ok) throw new Error(made.message);
    return made.value.server.id;
  }

  /** Arrangement only: a Bought Server of Hopper Labs holding `machineId`. */
  async function givenBoughtServer(
    stage: BoughtServerStage,
    machineId: number | null,
  ): Promise<string> {
    const [row] = await ctx.db
      .insert(boughtServer)
      .values({
        organizationId: grace.organizationId,
        name: `web-${stage}`,
        stage,
        serverType: 'cpx22',
        location: 'hel1',
        backups: false,
        providerServerId: machineId,
        termsAcceptedBy: grace.id,
        termsAcceptedAt: new Date(),
      })
      .returning({ id: boughtServer.id });
    return row.id;
  }

  async function listed(cookie = staffCookie): Promise<ListedOrphan[]> {
    const res = await request(http)
      .get('/operator/bought-servers/orphans')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as ListedOrphan[];
  }

  function orphanEmails() {
    return mail.sent.filter((sent) => ORPHAN_SUBJECT.test(sent.email.subject));
  }

  function deletes() {
    return ctx.hetzner.machines.calls.filter((call) =>
      ['deleteServer', 'deleteVolume', 'deletePrimaryIp'].includes(call.method),
    );
  }

  describe('the hourly check', () => {
    it('lists a labelled machine with no Bought Server behind it, with its labels and age, and emails the Operators once', async () => {
      const labels = labelsOf({
        id: 'lostserver000001',
        organizationId: grace.organizationId,
      });
      const machineId = await givenMachine('cloudgate-lost', labels);

      const tick = await hourly.tick(new Date('2026-11-10T10:51:00Z'));

      expect(tick.orphans).toEqual({
        orphans: [machineId],
        found: [machineId],
      });
      expect(await listed()).toEqual([
        {
          providerServerId: machineId,
          name: 'cloudgate-lost',
          location: 'hel1',
          labels,
          createdAt: expect.any(String) as string,
          foundAt: '2026-11-10T10:51:00.000Z',
          seenAt: '2026-11-10T10:51:00.000Z',
        },
      ]);
      const emails = orphanEmails();
      expect(emails.map((sent) => sent.to)).toEqual([HOSTED_STAFF.email]);
      expect(emails[0].email.subject).toBe('A machine nothing owns was found');
      expect(emails[0].email.html).toContain('cloudgate-lost');
      expect(emails[0].email.html).toContain(String(machineId));
      expect(emails[0].email.html).not.toMatch(/hetzner/i);

      // The next hours find it again and say nothing more.
      mail.clear();
      const again = await hourly.tick(new Date('2026-11-10T11:51:00Z'));
      await hourly.tick(new Date('2026-11-10T12:51:00Z'));

      expect(again.orphans).toEqual({ orphans: [machineId], found: [] });
      expect(orphanEmails()).toEqual([]);
      expect(await listed()).toEqual([
        expect.objectContaining({
          providerServerId: machineId,
          foundAt: '2026-11-10T10:51:00.000Z',
          seenAt: '2026-11-10T12:51:00.000Z',
        }),
      ]);
    });

    it('never lists a machine a live Bought Server holds, whatever its stage', async () => {
      for (const stage of [
        'creating',
        'setting_up',
        'ready',
        'changing',
        'deleting',
      ] as const) {
        const id = await givenBoughtServer(stage, null);
        const machineId = await givenMachine(
          `cloudgate-${id}`,
          labelsOf({ id, organizationId: grace.organizationId }),
        );
        // Ready and later have its id stored; Creating may not yet.
        if (stage !== 'creating') {
          await ctx.db
            .update(boughtServer)
            .set({ providerServerId: machineId })
            .where(eq(boughtServer.id, id));
        }
      }

      const tick = await hourly.tick(new Date('2026-11-10T10:51:00Z'));

      expect(tick.orphans).toEqual({ orphans: [], found: [] });
      expect(await listed()).toEqual([]);
      expect(orphanEmails()).toEqual([]);
    });

    it('lists the machine of a Deleted Bought Server, and leaves an unlabelled machine alone', async () => {
      const id = await givenBoughtServer('deleted', null);
      const left = await givenMachine(
        `cloudgate-${id}`,
        labelsOf({ id, organizationId: grace.organizationId }),
      );
      await ctx.db
        .update(boughtServer)
        .set({ providerServerId: left })
        .where(eq(boughtServer.id, id));
      await givenMachine('octabyte-own', { team: 'ops' });

      await hourly.tick(new Date('2026-11-10T10:51:00Z'));

      expect((await listed()).map((m) => m.providerServerId)).toEqual([left]);
    });

    it('never deletes anything, and drops a machine from the list once it is gone', async () => {
      const machineId = await givenMachine(
        'cloudgate-lost',
        labelsOf({ id: 'lostserver000001', organizationId: 'org' }),
      );

      await hourly.tick(new Date('2026-11-10T10:51:00Z'));
      expect(deletes()).toEqual([]);
      expect(ctx.hetzner.machines.servers().map((m) => m.id)).toContain(
        machineId,
      );

      // Deleted by hand at the provider: the next tick forgets it.
      await ctx.hetzner.machines.deleteServer(machineId);
      await hourly.tick(new Date('2026-11-10T11:51:00Z'));
      expect(await listed()).toEqual([]);
    });

    it('keeps the list as it was while the provider cannot be read', async () => {
      const machineId = await givenMachine(
        'cloudgate-lost',
        labelsOf({ id: 'lostserver000001', organizationId: 'org' }),
      );
      await hourly.tick(new Date('2026-11-10T10:51:00Z'));
      ctx.hetzner.machines.refuse('listServers', 'unavailable');

      const tick = await hourly.tick(new Date('2026-11-10T11:51:00Z'));

      expect(tick.orphans).toBeNull();
      expect((await listed()).map((m) => m.providerServerId)).toEqual([
        machineId,
      ]);
    });
  });

  describe('Delete', () => {
    it('deletes the machine with its Volume and Primary IPs, and is audited in the Instance organization', async () => {
      const labels = labelsOf({
        id: 'lostserver000001',
        organizationId: grace.organizationId,
      });
      const machineId = await givenMachine('cloudgate-lost', labels);
      const volume = await ctx.hetzner.machines.createVolume({
        name: 'cloudgate-lost-data',
        sizeGb: 20,
        location: 'hel1',
        labels,
      });
      if (!volume.ok) throw new Error(volume.message);
      await ctx.hetzner.machines.attachVolume(
        volume.value.volume.id,
        machineId,
      );
      await hourly.tick(new Date('2026-11-10T10:51:00Z'));

      const res = await request(http)
        .delete(`/operator/bought-servers/orphans/${machineId}`)
        .set('Cookie', staffCookie);

      expect(res.status).toBe(204);
      expect(ctx.hetzner.machines.servers()).toEqual([]);
      expect(ctx.hetzner.machines.volumes()).toEqual([]);
      expect(ctx.hetzner.machines.primaryIps()).toEqual([]);
      expect(await listed()).toEqual([]);

      const trail = await request(http)
        .get('/audit-logs')
        .query({ resourceType: 'organization' })
        .set('Cookie', staffCookie);
      const rows = (trail.body as { logs: AuditRow[] }).logs.filter((row) =>
        row.metadata?.includes('deleteOrphanMachine'),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        organizationId: instanceOrganizationId,
        userEmail: HOSTED_STAFF.email,
        action: 'update',
        resourceId: instanceOrganizationId,
      });
      const metadata = JSON.parse(rows[0].metadata!) as Record<string, unknown>;
      expect(metadata).toMatchObject({
        type: 'deleteOrphanMachine',
        providerServerId: machineId,
        labels,
        machineDeleted: true,
        volumeIds: [volume.value.volume.id],
      });
    });

    it('refuses a machine a live Bought Server owns again, and deletes nothing', async () => {
      const id = 'restoredsrv00001';
      const machineId = await givenMachine(
        'cloudgate-restored',
        labelsOf({ id, organizationId: grace.organizationId }),
      );
      await hourly.tick(new Date('2026-11-10T10:51:00Z'));
      // The row comes back, as after a restore.
      await ctx.db.insert(boughtServer).values({
        id,
        organizationId: grace.organizationId,
        name: 'restored',
        stage: 'ready',
        serverType: 'cpx22',
        location: 'hel1',
        backups: false,
        providerServerId: machineId,
        termsAcceptedBy: grace.id,
        termsAcceptedAt: new Date(),
      });

      const res = await request(http)
        .delete(`/operator/bought-servers/orphans/${machineId}`)
        .set('Cookie', staffCookie);

      expect(res.status).toBe(409);
      expect(deletes()).toEqual([]);
      expect(await listed()).toEqual([]);
    });

    it('answers 404 for a machine not on the list', async () => {
      const machineId = await givenMachine('cloudgate-unchecked', {
        'cloudgate-server': 'x',
      });

      const res = await request(http)
        .delete(`/operator/bought-servers/orphans/${machineId}`)
        .set('Cookie', staffCookie);

      expect(res.status).toBe(404);
      expect(deletes()).toEqual([]);
    });

    it('is for Operators only', async () => {
      const machineId = await givenMachine('cloudgate-lost', {
        'cloudgate-server': 'x',
      });
      await hourly.tick(new Date('2026-11-10T10:51:00Z'));

      const list = await request(http)
        .get('/operator/bought-servers/orphans')
        .set('Cookie', grace.cookie);
      const del = await request(http)
        .delete(`/operator/bought-servers/orphans/${machineId}`)
        .set('Cookie', grace.cookie);

      expect(list.status).toBe(403);
      expect(del.status).toBe(403);
      expect(deletes()).toEqual([]);
    });
  });
});
