import { exec } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { SchedulingService } from '../../src/scheduling/scheduling.service';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  idKey,
  networkName,
} from '../../src/cloud-accounts/gcp/definitions/names';
import { makeSigningKey } from '../../src/cloud-accounts/gcp/id-token';
import { InfrastructureStatesService } from '../../src/cloud-accounts/infrastructure-state/infrastructure-states.service';
import { tofuStates } from '../../src/cloud-accounts/infrastructure-state/infrastructure-state.schema';
import {
  application,
  auditLog,
  cloudAccount,
  deployment,
  domain,
  environment,
  environmentNetwork,
  postgres,
  redis,
  webServerSettings,
} from '../../src/db/schema';
import {
  SUBNET_HOLD_RETRY_JOB,
  SubnetHoldRetries,
} from '../../src/environments/subnet-hold-retries.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import type { FakeGoogleCall } from '../utils/fake-google-cloud-port';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { createTestApp, TestAppContext } from '../utils/test-app';

/** What a Domain's own network run targets: its three blocks and the URL map. */
const DOMAIN_RUN_TARGETS = [
  'google_certificate_manager_dns_authorization.domain',
  'google_certificate_manager_certificate.domain',
  'google_certificate_manager_certificate_map_entry.domain',
  'google_compute_url_map.network',
];

jest.setTimeout(180_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';
const REGION = 'europe-west1';
const NETWORK = `Environment network (${REGION})`;
const HOUR = 60 * 60 * 1000;

/** A `docker` that removes nothing and fails nothing. */
const FAKE_DOCKER = '#!/bin/bash\nexit 0\n';

/** Google's refusal of a subnet its services used, as the provider prints it. */
const SUBNET_IN_USE = (subnet: string) =>
  `Error waiting for Deleting Subnetwork: The subnetwork resource 'projects/${PROJECT}/regions/${REGION}/subnetworks/${subnet}' is already being used by 'projects/${PROJECT}/regions/${REGION}/addresses/serverless-ipv4-1234'`;

/** A held removal's sentence, its time `HH:MM` of Cloudgate's next try. */
const HELD = (subnet: string, network: string) =>
  new RegExp(
    `^${NETWORK.replace(/[()]/g, '\\$&')}: Google Cloud still holds subnet ${subnet} and network ${network}\\. Google releases this 1–2 hours after the services are gone; Cloudgate will try again at \\d\\d:\\d\\d UTC$`,
  );

/**
 * "Delete" and "The subnet hold" (S13, ADR-0038): an Environment's Delete on
 * Google Cloud takes every Domain off the network in one network run, then deletes each
 * Service (its own network step skipped), then removes the network last.
 * Google holds a used subnet 1–2 hours, so the Delete ends incomplete
 * naming the subnet and network and when Cloudgate tries again, which a
 * once-a-minute sweep does at about 2 and about 4 hours. Against the
 * Google fake, whose stand-in `tofu` replays empty plans, with the sweep
 * driven by a test clock.
 */
describe('Deleting an Environment on Google Cloud (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;
  let cloudAccountId: string;
  let environmentId: string;
  let networkId: string;
  let networkState: string;
  let webState: string;
  let subnet: string;
  let vpc: string;
  const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cloudgate-genvdel-'));
  const bin = nodePath.join(root, 'bin');
  const saved = process.env.CLOUDGATE_DIRECTORY;

  const execMock = withArgvExec({
    execAsync: jest.fn(
      (command: string, options?: { env?: NodeJS.ProcessEnv }) =>
        new Promise((resolve, reject) => {
          exec(
            command,
            {
              shell: '/bin/bash',
              env: {
                ...process.env,
                ...options?.env,
                PATH: `${bin}:${process.env.PATH}`,
              },
            },
            (error, stdout, stderr) =>
              error
                ? reject(Object.assign(error, { stdout, stderr }))
                : resolve({ stdout, stderr, exitCode: 0 }),
          );
        }),
    ),
    execAsyncRemote: jest.fn(),
  });

  beforeAll(async () => {
    process.env.CLOUDGATE_DIRECTORY = root;
    fs.mkdirSync(bin);
    fs.writeFileSync(nodePath.join(bin, 'docker'), FAKE_DOCKER, {
      mode: 0o755,
    });
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
    if (saved === undefined) delete process.env.CLOUDGATE_DIRECTORY;
    else process.env.CLOUDGATE_DIRECTORY = saved;
    fs.rmSync(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await ctx.resetDb();
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
    const res = await request(http).post('/api/auth/sign-up/email').send(owner);
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'shop' });
    projectId = (project.body as { projectId: string }).projectId;

    const key = makeSigningKey();
    const [account] = await ctx.db
      .insert(cloudAccount)
      .values({
        organizationId,
        name: 'Production Google',
        cloud: 'gcp',
        cloudId: PROJECT,
        ...GOOGLE_COLUMNS,
        signingKey: key.privateKey,
        signingKeyId: key.keyId,
        signingPublicKey: JSON.stringify(key.publicJwk),
        policyVersion: 1,
        lastCheckedAt: new Date().toISOString(),
        lastCheckResult: 'passed',
      })
      .returning();
    cloudAccountId = account.cloudAccountId;
    const env = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        projectId,
        name: 'production',
        deployTarget: { kind: 'cloud', cloudAccountId, region: REGION },
      });
    expect(env.status).toBe(201);
    environmentId = (env.body as { environmentId: string }).environmentId;
    subnet = networkName(environmentId, 'subnet');
    vpc = networkName(environmentId, 'net');

    const [network] = await ctx.db
      .insert(environmentNetwork)
      .values({
        environmentId,
        cloudAccountId,
        region: REGION,
        status: 'ready',
        networkName: vpc,
        subnetName: subnet,
        ipAddress: '34.120.0.7',
        urlMapName: networkName(environmentId, 'urls'),
        certificateMapName: networkName(environmentId, 'certs'),
        privateLinks: ['cloud-sql'],
      })
      .returning();
    networkId = network.environmentNetworkId;
    const states = ctx.app.get(InfrastructureStatesService);
    networkState = (
      await states.create(
        { environmentNetworkId: networkId },
        undefined,
        'google',
      )
    ).infrastructureStateId;

    // A web with a Domain on the network's load balancer, as its deploy
    // and Domain run leave it.
    const [web] = await ctx.db
      .insert(application)
      .values({
        name: 'web',
        environmentId,
        configName: 'web',
        configKind: 'web',
        sourceType: 'docker',
        dockerImage: 'nginx',
        port: 8080,
        cloudAccountId,
        region: REGION,
        applicationStatus: 'done',
      })
      .returning();
    webState = (
      await states.create(
        { applicationId: web.applicationId },
        undefined,
        'google',
      )
    ).infrastructureStateId;
    await ctx.db.insert(tofuStates).values([
      { name: webState, data: 'encrypted-by-opentofu' },
      { name: networkState, data: 'encrypted-by-opentofu' },
    ]);
    await ctx.db.insert(domain).values({
      host: 'shop.acme.dev',
      applicationId: web.applicationId,
      cloudCertificateStatus: 'live',
      googleCertificateName: `projects/${PROJECT}/locations/global/certificates/x`,
    });
    ctx.google.reset();
  });

  async function until(check: () => Promise<boolean>, ms = 30_000) {
    const deadline = Date.now() + ms;
    while (!(await check())) {
      if (Date.now() > deadline) throw new Error('timed out waiting');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async function envRow() {
    const [row] = await ctx.db
      .select()
      .from(environment)
      .where(eq(environment.environmentId, environmentId));
    return row;
  }
  async function networkRow() {
    const [row] = await ctx.db
      .select()
      .from(environmentNetwork)
      .where(eq(environmentNetwork.environmentNetworkId, networkId));
    return row;
  }
  const incomplete = async () =>
    (await envRow())?.cloudDelete?.status === 'incomplete';
  const settled = async () =>
    (await ctx.db.select().from(deployment)).every(
      (one) => one.status !== 'running' && one.status !== 'pending',
    );

  const del = () =>
    request(http)
      .delete(`/environments/${environmentId}`)
      .set('Cookie', cookie);
  const post = (action: string) =>
    request(http)
      .post(`/environments/${environmentId}/delete/${action}`)
      .set('Cookie', cookie);

  /** The `tofu` runs the fake answered, in order: a Domain run, or a destroy of which state. */
  const runs = () =>
    ctx.google.calls.flatMap((call: FakeGoogleCall) =>
      call.method === 'apply'
        ? [`apply:${call.kind}`]
        : call.method === 'destroy'
          ? [
              `destroy:${call.stateId === networkState ? 'network' : call.stateId === webState ? 'web' : call.stateId}`,
            ]
          : [],
    );
  const networkDestroys = () =>
    runs().filter((one) => one === 'destroy:network').length;

  /** Google still holds the network's subnet, and its VPC network with it. */
  function holdSubnet() {
    ctx.google.failDestroyOf(networkState, SUBNET_IN_USE(subnet));
    ctx.google.find(
      {
        resourceType: 'google_compute_subnetwork',
        name: subnet,
        id: `projects/${PROJECT}/regions/${REGION}/subnetworks/${subnet}`,
      },
      {
        resourceType: 'google_compute_network',
        name: vpc,
        id: `projects/${PROJECT}/global/networks/${vpc}`,
      },
    );
  }
  function releaseSubnet() {
    ctx.google.failDestroyOf(networkState, null);
    ctx.google.findNothing();
  }

  /** What Google's hold leaves: the subnet, and the VPC network with it. */
  const HELD_LEFT = () => [
    {
      type: 'compute.googleapis.com/Subnetwork',
      googleName: subnet,
      region: REGION,
      label: null,
    },
    {
      type: 'compute.googleapis.com/Network',
      googleName: vpc,
      region: 'global',
      label: null,
    },
  ];
  /** {@link HELD_LEFT} as the Environment's Delete lists it, with whose it is. */
  const LEFT = () => HELD_LEFT().map((one) => ({ ...one, of: NETWORK }));

  const sweeper = () => ctx.app.get(SubnetHoldRetries);
  /** One sweep at `ms` after the network's next try is due. */
  async function sweepPast(ms: number) {
    const due = (await networkRow()).holdNextTryAt!;
    await sweeper().sweep(new Date(Date.parse(due) + ms));
  }

  it('takes every Domain off the network in one run, then deletes each Service, then removes the network, and the Environment goes', async () => {
    const res = await del();

    expect(res.status).toBe(200);
    // The record left at the DNS provider points at the network's fixed IP,
    // an A record, never a CNAME to "the load balancer" (the live walk).
    expect((res.body as { dnsRecordsLeft: unknown }).dnsRecordsLeft).toEqual([
      { name: 'shop.acme.dev', type: 'A', value: '34.120.0.7' },
    ]);
    await until(async () => (await envRow()) === undefined);

    expect(runs()).toEqual(['apply:network', 'destroy:web', 'destroy:network']);
    // The Domain run, with every Domain left out.
    expect(
      ctx.google.calls.find(
        (call) => call.method === 'apply' && call.kind === 'network',
      ),
    ).toMatchObject({ targets: DOMAIN_RUN_TARGETS, domains: {} });
    // The network's search, by its names, its private link among them.
    const searched = ctx.google.calls.flatMap((call) =>
      call.method === 'findByName' ? [call.resourceType] : [],
    );
    expect(searched).toEqual(
      expect.arrayContaining([
        'google_network_connectivity_service_connection_policy',
        'google_compute_subnetwork',
        'google_compute_network',
      ]),
    );
    expect(await networkRow()).toBeUndefined();
    // The Delete's audit row is written after the Environment's row goes, so
    // it is waited for rather than read the moment the row is gone.
    const finished = async () =>
      (
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.resourceId, environmentId))
      ).some((one) =>
        (one.metadata ?? '').includes('"cloudDelete":"finished"'),
      );
    await until(finished);
  });

  it('stops before any Service is touched when the Domain run fails', async () => {
    ctx.google.failApplyFor(
      'network',
      'Error 403: Permission compute.urlMaps.update denied',
    );

    expect((await del()).status).toBe(200);
    await until(incomplete);
    await until(settled);

    expect(runs()).not.toContain('destroy:web');
    expect((await envRow()).cloudDelete!.unfinished).toMatch(
      /^The network step that takes every Domain off failed before any Service was touched: .*compute\.urlMaps\.update denied/,
    );
  });

  it("ends incomplete at Google's subnet hold, saying when Cloudgate tries again, which its sweep does at about 2 and 4 hours, even after a restart, and then waits", async () => {
    holdSubnet();

    expect((await del()).status).toBe(200);
    await until(incomplete);
    await until(settled);

    const first = (await envRow()).cloudDelete!;
    expect(first.left).toEqual(LEFT());
    expect(first.unfinished).toMatch(HELD(subnet, vpc));
    const held = await networkRow();
    expect(held).toMatchObject({
      status: 'delete-incomplete',
      holdTriesLeft: 2,
    });
    const due = Date.parse(held.holdNextTryAt!);
    expect(due - Date.now()).toBeGreaterThan(2 * HOUR - 60_000);
    expect(due - Date.now()).toBeLessThanOrEqual(2 * HOUR);
    expect(first.unfinished).toContain(
      `try again at ${held.holdNextTryAt!.slice(11, 16)} UTC`,
    );

    // Before its time, the sweep queues nothing.
    await sweeper().sweep(new Date(due - 60_000));
    expect(networkDestroys()).toBe(1);

    // About 2 hours on: a Retry of the Delete, Cloudgate's own.
    await sweepPast(60_000);
    expect((await envRow()).cloudDelete).toMatchObject({
      status: 'deleting',
      retrying: true,
    });
    await until(incomplete);
    await until(settled);
    expect(networkDestroys()).toBe(2);
    expect(await networkRow()).toMatchObject({ holdTriesLeft: 1 });
    expect((await networkRow()).holdNextTryAt).not.toBeNull();

    // A restart in between: the sweep, armed again at start-up, reads the
    // schedule from the row and queues the next try.
    sweeper().onApplicationBootstrap();
    expect(ctx.app.get(SchedulingService).has(SUBNET_HOLD_RETRY_JOB)).toBe(
      true,
    );
    await sweepPast(60_000);
    await until(incomplete);
    await until(settled);
    expect(networkDestroys()).toBe(3);

    // After the 4-hour try it waits for Retry or Forget.
    const waiting = await networkRow();
    expect(waiting).toMatchObject({ holdTriesLeft: 0, holdNextTryAt: null });
    expect((await envRow()).cloudDelete!.unfinished).toMatch(
      /Cloudgate has tried again twice by itself, so Retry once Google has released it, or Forget it$/,
    );
    await sweeper().sweep(new Date(Date.now() + 24 * HOUR));
    expect(networkDestroys()).toBe(3);
  });

  it('finishes the Delete when its own try finds the subnet released', async () => {
    holdSubnet();
    await del();
    await until(incomplete);
    await until(settled);

    releaseSubnet();
    await sweepPast(60_000);

    await until(async () => (await envRow()) === undefined);
    expect(await networkRow()).toBeUndefined();
  });

  it('runs a Retry at once at any time, clearing the schedule, and Forget writes what is left into the audit entry', async () => {
    holdSubnet();
    await del();
    await until(incomplete);
    await until(settled);
    await sweepPast(60_000);
    await until(incomplete);
    await until(settled);
    expect(await networkRow()).toMatchObject({ holdTriesLeft: 1 });

    // Retry, long before the next try: it runs now, and starts the
    // schedule again from its own ending.
    const retried = await post('retry');
    expect(retried.status).toBe(200);
    await until(incomplete);
    await until(settled);
    expect(networkDestroys()).toBe(3);
    expect(await networkRow()).toMatchObject({ holdTriesLeft: 2 });

    const forgotten = await post('forget');

    expect(forgotten.status).toBe(200);
    expect(await envRow()).toBeUndefined();
    expect(await networkRow()).toBeUndefined();
    const entry = (
      await ctx.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.resourceId, environmentId))
    ).find((one) => (one.metadata ?? '').includes('"cloudDelete":"forgotten"'));
    expect(JSON.parse(entry!.metadata!)).toMatchObject({ left: LEFT() });
  });

  it('finishes clean on a Retry by hand once Google has released the subnet', async () => {
    holdSubnet();
    await del();
    await until(incomplete);
    await until(settled);

    releaseSubnet();
    expect((await post('retry')).status).toBe(200);

    await until(async () => (await envRow()) === undefined);
  });

  /**
   * Deleting the Environment: with a postgres on Cloud
   * SQL and a redis on Memorystore, the databases' states are destroyed
   * before the network's, whose state holds the private link; then a
   * label search for the Environment's label names anything Google keeps.
   */
  describe('with a postgres on Cloud SQL and a redis on Memorystore', () => {
    let pgState: string;
    let redisState: string;
    const ENV_LABEL = () => ({
      'cloudgate-environment': idKey(environmentId),
    });
    /** A Private Service Connect address Google still lists, as `CLOSED`. */
    const CLOSED_ADDRESS = () => ({
      type: 'compute.googleapis.com/Address',
      id: `projects/${PROJECT}/regions/${REGION}/addresses/sca-auto-addr-pg-1`,
      region: REGION,
      labels: { ...ENV_LABEL(), 'cloudgate-state': 'pgstatekey00' },
    });
    const CLOSED_LEFT = () => ({
      type: 'compute.googleapis.com/Address',
      googleName: `projects/${PROJECT}/regions/${REGION}/addresses/sca-auto-addr-pg-1`,
      region: REGION,
      label: 'cloudgate-state=pgstatekey00',
      of: `Google Cloud project ${PROJECT}, by its label`,
    });

    beforeEach(async () => {
      await ctx.db
        .update(environmentNetwork)
        .set({ privateLinks: ['cloud-sql', 'memorystore'] })
        .where(eq(environmentNetwork.environmentNetworkId, networkId));
      const states = ctx.app.get(InfrastructureStatesService);
      const [pg] = await ctx.db
        .insert(postgres)
        .values({
          name: 'pg-1',
          environmentId,
          configName: 'pg-1',
          appName: 'cloudgate-pg-1',
          dockerImage: 'postgres:17',
          instanceClass: 'db-g1-small',
          databaseName: 'app',
          databaseUser: 'app',
          databasePassword: 'super-secret-database-password',
          cloudAccountId,
          region: REGION,
        })
        .returning();
      const [cache] = await ctx.db
        .insert(redis)
        .values({
          name: 'redis',
          environmentId,
          configName: 'redis',
          appName: 'cloudgate-redis',
          databasePassword: 'super-secret-token',
          nodeType: 'CUSTOM_PICO',
          cloudAccountId,
          region: REGION,
        })
        .returning();
      pgState = (
        await states.create({ postgresId: pg.postgresId }, undefined, 'google')
      ).infrastructureStateId;
      redisState = (
        await states.create({ redisId: cache.redisId }, undefined, 'google')
      ).infrastructureStateId;
      await ctx.db.insert(tofuStates).values([
        { name: pgState, data: 'encrypted-by-opentofu' },
        { name: redisState, data: 'encrypted-by-opentofu' },
      ]);
    });

    /** Each destroy and the label search, in the order Google was asked. */
    const order = () =>
      ctx.google.calls.flatMap((call: FakeGoogleCall) =>
        call.method === 'destroy'
          ? [
              call.stateId === pgState
                ? 'destroy:postgres'
                : call.stateId === redisState
                  ? 'destroy:redis'
                  : call.stateId === networkState
                    ? 'destroy:network'
                    : 'destroy:web',
            ]
          : call.method === 'findByLabel'
            ? ['label search']
            : [],
      );

    it('destroys both databases before the network, whose state holds the private link, then searches by label, and a clean search lets the Environment go', async () => {
      expect((await del()).status).toBe(200);
      await until(async () => (await envRow()) === undefined);

      const asked = order();
      expect(asked).toHaveLength(5);
      expect(asked.indexOf('destroy:network')).toBeGreaterThan(
        asked.indexOf('destroy:postgres'),
      );
      expect(asked.indexOf('destroy:network')).toBeGreaterThan(
        asked.indexOf('destroy:redis'),
      );
      expect(asked.slice(-2)).toEqual(['destroy:network', 'label search']);
      expect(
        ctx.google.calls.find((call) => call.method === 'findByLabel'),
      ).toMatchObject({
        projectId: PROJECT,
        label: { key: 'cloudgate-environment', value: idKey(environmentId) },
      });
    });

    it('never asks whether to delete their data: each keeps its final backup, named once as kept in its own Delete report', async () => {
      const today = new Date().toISOString().slice(0, 10);
      expect((await del()).status).toBe(200);
      await until(async () => (await envRow()) === undefined);

      expect(
        ctx.google.calls.flatMap((call) =>
          call.method === 'takeCloudSqlBackup'
            ? [`cloud-sql ${call.description}`]
            : call.method === 'takeMemorystoreBackup'
              ? [`memorystore ${call.backupId}`]
              : call.method === 'stopRetainingCloudSqlBackups'
                ? ['retained backups off']
                : [],
        ),
      ).toEqual(
        expect.arrayContaining([
          `cloud-sql shop-production-pg-1-final-${today}`,
          `memorystore shop-production-redis-final-${today}`,
        ]),
      );
      expect(
        ctx.google.calls.filter(
          (call) => call.method === 'stopRetainingCloudSqlBackups',
        ),
      ).toEqual([]);

      const keptBy = async (name: string) => {
        const entry = (
          await ctx.db
            .select()
            .from(auditLog)
            .where(eq(auditLog.resourceName, name))
        ).find((one) =>
          (one.metadata ?? '').includes('"cloudDelete":"finished"'),
        );
        return (JSON.parse(entry!.metadata!) as { kept: unknown[] }).kept;
      };
      // The fake's backups hold 2 GiB of Postgres and 1 GiB (1.07 GB) of Valkey.
      expect(await keptBy('pg-1')).toEqual([
        {
          type: 'cloud-sql:backup',
          awsId: `shop-production-pg-1-final-${today}`,
          region: 'us',
          size: '2 GiB',
          cost: 'about $0.16 a month until you delete it in Google Cloud',
        },
      ]);
      expect(await keptBy('redis')).toEqual([
        {
          type: 'memorystore:backup',
          awsId: `shop-production-redis-final-${today}`,
          region: REGION,
          size: '1.07 GB',
          cost: 'about $0.09 a month until you delete it in Google Cloud',
        },
      ]);
    });

    it('refuses the Environment Delete while its Cloud SQL instance is stopped, naming it, with nothing changed on Google', async () => {
      await ctx.db
        .update(postgres)
        .set({ applicationStatus: 'stopped' })
        .where(eq(postgres.name, 'pg-1'));
      ctx.google.calls.length = 0;

      const res = await del();
      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'pg-1 is stopped. Start it first, then delete it.',
      );
      expect(
        ctx.google.calls.filter((call) =>
          [
            'apply',
            'destroy',
            'liftCloudSqlDeletionProtection',
            'takeCloudSqlBackup',
            'takeMemorystoreBackup',
          ].includes(call.method),
        ),
      ).toEqual([]);
      expect((await envRow())?.cloudDelete).toBeNull();
    });

    it('keeps the Environment Delete incomplete naming what the label search found, by type, Google id, region and label; Retry searches again and lets it go once Google has let go', async () => {
      ctx.google.findLabelled(CLOSED_ADDRESS(), {
        ...CLOSED_ADDRESS(),
        id: 'projects/other/regions/x/addresses/someone-elses',
        labels: { 'cloudgate-environment': 'anotherenvir' },
      });

      expect((await del()).status).toBe(200);
      await until(incomplete);
      await until(settled);

      expect(await networkRow()).toBeUndefined();
      expect((await envRow()).cloudDelete).toMatchObject({
        status: 'incomplete',
        left: [CLOSED_LEFT()],
        unfinished: null,
      });
      const shown = await request(http)
        .get(`/environments/${environmentId}`)
        .set('Cookie', cookie);
      expect(shown.body).toMatchObject({
        cloudDelete: { status: 'incomplete', left: [CLOSED_LEFT()] },
      });

      // Still there on a Retry: searched again, still named.
      expect((await post('retry')).status).toBe(200);
      await until(incomplete);
      expect(order().filter((one) => one === 'label search')).toHaveLength(2);
      expect((await envRow()).cloudDelete!.left).toEqual([CLOSED_LEFT()]);

      ctx.google.findNothing();
      expect((await post('retry')).status).toBe(200);
      await until(async () => (await envRow()) === undefined);
    });

    it('Forget writes what the label search found into the audit entry', async () => {
      ctx.google.findLabelled(CLOSED_ADDRESS());
      await del();
      await until(incomplete);
      await until(settled);

      expect((await post('forget')).status).toBe(200);

      expect(await envRow()).toBeUndefined();
      const entry = (
        await ctx.db
          .select()
          .from(auditLog)
          .where(eq(auditLog.resourceId, environmentId))
      ).find((one) =>
        (one.metadata ?? '').includes('"cloudDelete":"forgotten"'),
      );
      expect(JSON.parse(entry!.metadata!)).toMatchObject({
        left: [CLOSED_LEFT()],
      });
    });

    it('keeps the Environment Delete incomplete, saying so, when Google refuses the label search', async () => {
      ctx.google.permissionDenied(
        'findByLabel',
        "Required 'compute.addresses.list' permission for 'projects/shop-prod'",
      );

      expect((await del()).status).toBe(200);
      await until(incomplete);
      await until(settled);

      expect(await networkRow()).toBeUndefined();
      expect((await envRow()).cloudDelete).toMatchObject({
        status: 'incomplete',
        left: [],
        unfinished: `What is left in Google Cloud could not be checked: Google refused the search by Cloudgate's label cloudgate-environment=${idKey(environmentId)}: Required 'compute.addresses.list' permission for 'projects/shop-prod'`,
      });
    });
  });

  describe('a network a Deploy target switch left with nothing in it', () => {
    beforeEach(async () => {
      await ctx.db
        .delete(application)
        .where(eq(application.environmentId, environmentId));
      const switched = await request(http)
        .patch(`/environments/${environmentId}`)
        .set('Cookie', cookie)
        .send({ deployTarget: { kind: 'platform-host' } });
      expect(switched.status).toBe(200);
    });

    async function plannedRemoval() {
      const savedPlan = await request(http)
        .post(`/projects/${projectId}/config/plans`)
        .set('Cookie', cookie)
        .send({ text: 'version: 1\nservices: {}\n' });
      expect(savedPlan.status).toBe(201);
      return (
        savedPlan.body as {
          plans: {
            planId: string;
            environmentId: string;
            steps: Record<string, unknown>[];
          }[];
        }
      ).plans.find((one) => one.environmentId === environmentId)!;
    }
    const apply = (planId: string, confirmDestroy: string[]) =>
      request(http)
        .post(`/environments/${environmentId}/plan/apply`)
        .set('Cookie', cookie)
        .send({ planId, confirmDestroy });

    it('needs the typed name, and follows the same hold rule', async () => {
      const open = await plannedRemoval();
      expect(open.steps).toEqual([
        expect.objectContaining({
          action: 'network-remove',
          environmentNetworkId: networkId,
          confirmName: `network-${REGION}`,
        }),
      ]);
      expect((await apply(open.planId, [])).status).toBe(409);
      expect(await networkRow()).toMatchObject({ status: 'ready' });

      holdSubnet();
      expect((await apply(open.planId, [`network-${REGION}`])).status).toBe(
        200,
      );
      await until(
        async () => (await networkRow())?.status === 'delete-incomplete',
      );
      await until(settled);
      expect(await networkRow()).toMatchObject({
        leftovers: HELD_LEFT(),
        holdTriesLeft: 2,
      });
      const views = await request(http)
        .get(`/environments/${environmentId}/networks`)
        .set('Cookie', cookie);
      expect(
        (views.body as { subnetHold: string | null }[])[0].subnetHold,
      ).toMatch(
        /^Google Cloud still holds subnet .* Cloudgate will try again at \d\d:\d\d UTC$/,
      );

      // Its own try, about 2 hours on, is the network's removal again.
      releaseSubnet();
      await sweepPast(60_000);
      await until(async () => (await networkRow()) === undefined);
      expect(networkDestroys()).toBe(2);
      expect(await envRow()).toBeDefined();
    });
  });
});
