import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { listDestinationObjectsSchema } from '../../src/destinations/dto/destination.dto';
import {
  backup as backupTable,
  server as serverTable,
} from '../../src/db/schema';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const r2Backups = {
  name: 'prod-backups',
  provider: 'Cloudflare',
  accessKey: 'AKIAEXAMPLEACCESSKEY',
  secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
  bucket: 'cloudgate-backups',
  region: 'auto',
  endpoint: 'https://accountid.r2.cloudflarestorage.com',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

// A test-connection payload someone would actually get a refusal from: the
// secret is wrong and the endpoint does not resolve.
const wrongSecret = {
  ...r2Backups,
  provider: 'Minio',
  secretAccessKey: 'WRONG-SECRET-abcdef0123456789',
  endpoint: 'http://host.docker.internal:9000',
};

/**
 * `r2Backups` with the credentials pasted into the endpoint as well, which is
 * what the two routes below need and `r2Backups` cannot give them.
 *
 * On `POST /destinations/:id/test-connection` and on the object listing the
 * caller sends no credentials at all — they come off the row. So the only way a
 * credential can reach one of those refusals is out of the stored row, through
 * the one stored field that reaches rclone's wire surface: `endpoint`, a free
 * `z.string()` an operator can and does paste a whole authenticated URL into.
 * `r2Backups`'s own endpoint is credential-free, so no rclone run against it
 * could have produced the URL the previous fixtures put in its mouth.
 */
const r2BackupsWithPastedCredentials = {
  ...r2Backups,
  endpoint:
    'https://AKIAEXAMPLEACCESSKEY:wJalrXUtnFEMI-example-secret-key@accountid.r2.cloudflarestorage.com',
};

/** The URL rclone names when it cannot reach that endpoint (see below). */
const r2DialledUrl =
  'https://AKIAEXAMPLEACCESSKEY:***@accountid.r2.cloudflarestorage.com' +
  '/cloudgate-backups?delimiter=&max-keys=1000&prefix=';

/**
 * What the exec boundary really throws: Node's `exec` prefixes the failure with
 * the command line it ran, then rclone's own output follows. Built from the
 * command the service actually passed, so a command carrying credentials
 * produces a message carrying credentials — exactly as in production.
 */
const unreachableEndpoint = (command: string) =>
  new Error(
    `Command execution failed: Command failed: ${command}\n` +
      '2026/08/07 09:14:02 ERROR : : error listing: RequestError: send request failed\n' +
      'caused by: Get "http://host.docker.internal:9000/cloudgate-backups?delimiter=%2F": ' +
      'dial tcp: lookup host.docker.internal: no such host\n',
  );

/**
 * The same failure as it really comes back from a *Server*.
 *
 * Nothing folds stderr into the message over SSH: `execAsyncRemote` rejects with
 * `Remote command failed with exit code 1` and rclone's own words reach the
 * caller only in `stderr`. F-44 measured this route with no `serverId`, where
 * Node's `exec` does fold, and so credited it with a diagnosis it does not have
 * on the path a Server-scoped probe actually takes.
 *
 * The `serverId` below is a *label on a failure*, not a lookup input — it says
 * which host the failing command ran on, and no route, `PermissionCtx` or
 * `checkServerAccess` is in reach of it. A sweep for fixtures naming a
 * Server nothing owns flagged it; it stays as it is, and this records why so
 * the next sweep does not flag it again.
 */
const unreachableEndpointOverSsh = (command: string) =>
  new ExecError('Remote command failed with exit code 1', {
    command,
    stdout: '',
    stderr:
      '2026/08/07 09:14:02 ERROR : : error listing: RequestError: send request failed\n' +
      'caused by: Get "http://host.docker.internal:9000/cloudgate-backups?delimiter=%2F": ' +
      'dial tcp: lookup host.docker.internal: no such host\n',
    exitCode: 1,
    serverId: 'server-1',
  });

/**
 * The **only** rclone failure shape that carries a credential — measured, not
 * imagined (and the defect in its own fix).
 *
 * `Destination.endpoint` is a free string, so an operator who pastes
 * `http://KEY:SECRET@host:9000` into it gets exactly that URL dialled. Driven
 * against rclone **v1.60.1**, the version `deploy/install.sh` leaves on the box
 * and the one the first verification run recorded, with a port nothing is
 * listening on:
 *
 *     Failed to ls: RequestError: send request failed
 *     caused by: Get "http://AKIAEXAMPLEACCESSKEY:***@127.0.0.1:9111/cloudgate-backups?delimiter=&max-keys=1000&prefix=": dial tcp 127.0.0.1:9111: connect: connection refused
 *
 * Two details in there are measurements rather than taste. The **username
 * survives** — that is the credential these tests exist to watch the mask take
 * out. The **password is already gone before anything of ours runs**, and it is
 * rendered `***`, not `xxxxx`: the string is built by `net/http`'s
 * `stripPassword`, which substitutes three asterisks, and not by
 * `url.Redacted()`, which is where `xxxxx` comes from. So every
 * `not.toContain(<secret>)` on this shape is **vacuous by construction** and is
 * kept only as a cheap invariant; the load-bearing assertion is the positive
 * one, that the masked URL comes back with `••••••` where the key was.
 *
 * What this shape does **not** contain is an S3 error code, a `status code:`
 * line or a request id — and that is the whole point. See
 * `S3_REFUSAL_NO_CREDENTIAL` below.
 */
const dialledEndpointRefused = (url: string, operation = 'ls') =>
  new Error(
    `Command execution failed: 2026/08/07 09:20:31 Failed to ${operation}: ` +
      'RequestError: send request failed\n' +
      `caused by: Get "${url}": dial tcp: connection refused\n`,
  );

/**
 * A refusal rclone relays from a *parsed* S3 error body, and the reason the two
 * halves the previous fixtures spliced together cannot both be in one error.
 *
 * Driven against the same rclone v1.60.1, pointed at a server answering 403 with
 * a `SignatureDoesNotMatch` document that also carried `<AWSAccessKeyId>`,
 * `<StringToSign>` and `<SignatureProvided>` elements:
 *
 *     Failed to ls: SignatureDoesNotMatch: The request signature we calculated does not match the signature you provided. Check your key and signing method.
 *     	status code: 403, request id: 17E4A1C0B8B2F0A1, host id:
 *
 * `aws-sdk-go` kept `Code` and `Message` and discarded everything else — the
 * access key the driving server volunteered is nowhere in the output — which is
 * this repo's earlier finding, re-driven. And there is **no URL and no
 * `caused by:` line at all**, because a parsed service error is an `awserr`
 * built from a response body, not from a `*url.Error`; the transport shape above
 * is a different value built at a different point in the SDK, with status code 0
 * and no S3 code. A 403 that arrived means the round trip completed;
 * `dial tcp: connection refused` means it never happened. rclone emits one or
 * the other.
 *
 * So this shape carries no credential and there is nothing here for the mask to
 * do. It is pinned anyway, because the mask must not eat a diagnosis either —
 * which is what the `SignatureDoesNotMatch` assertions on the credential-bearing
 * fixtures were reaching for, on an error that could not have existed.
 */
const S3_REFUSAL_NO_CREDENTIAL =
  'Command execution failed: 2026/08/07 09:20:31 Failed to ls: ' +
  'SignatureDoesNotMatch: The request signature we calculated does not match ' +
  'the signature you provided. Check your key and signing method.\n' +
  '\tstatus code: 403, request id: 17E4A1C0B8B2F0A1, host id: \n';

describe('Destinations (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let destinations: DestinationsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    destinations = ctx.app.get(DestinationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '' });
    execMock.execAsyncRemote.mockReset().mockResolvedValue('');
  });

  /**
   * A `server` row in `organizationId`. Both probe routes scope the `serverId`
   * they are handed, so a test that wants the SSH branch has to name
   * a Server the caller's organization actually owns — a bare id no longer
   * reaches the exec at all.
   */
  async function insertServer(organizationId: string, name = 'ours') {
    const [row] = await ctx.db
      .insert(serverTable)
      .values({
        name,
        ipAddress: '203.0.113.7',
        port: 22,
        organizationId,
      })
      .returning();
    return row;
  }

  /** A Server belonging to a second organization the same owner created. */
  async function insertForeignServer(cookie: string) {
    const stranger = await createOrganization(server, ctx.db, cookie, {
      name: 'other-tenant',
      slug: `other-${Date.now()}`,
    });
    return insertServer((stranger.body as { id: string }).id, 'not-yours');
  }

  describe('create → findOne', () => {
    it('stores a destination retrievable by id, secret encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await destinations.create(ownerCtx, r2Backups);

      expect(created.destinationId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);
      expect(created).not.toHaveProperty('secretAccessKey');

      const found = await destinations.findOne(ownerCtx, created.destinationId);
      expect(found).toMatchObject({
        destinationId: created.destinationId,
        name: 'prod-backups',
        provider: 'Cloudflare',
        accessKey: 'AKIAEXAMPLEACCESSKEY',
        bucket: 'cloudgate-backups',
        region: 'auto',
        endpoint: 'https://accountid.r2.cloudflarestorage.com',
        organizationId,
      });
      expect(found).not.toHaveProperty('secretAccessKey');

      const raw = await ctx.db.$client.query<{ secret_access_key: string }>(
        'select secret_access_key from destination where destination_id = $1',
        [created.destinationId],
      );
      expect(raw.rows[0].secret_access_key).not.toContain(
        'wJalrXUtnFEMI-example-secret-key',
      );
      expect(raw.rows[0].secret_access_key.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it('lists the organization destinations newest first, secrets stripped', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await destinations.create(ownerCtx, { ...r2Backups, name: 'older' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await destinations.create(ownerCtx, { ...r2Backups, name: 'newer' });

      const listed = await destinations.list(ownerCtx);
      expect(listed.map((d) => d.name)).toEqual(['newer', 'older']);
      for (const item of listed) {
        expect(item).not.toHaveProperty('secretAccessKey');
      }
    });
  });

  describe('update', () => {
    it('changes the given fields; a rotated secret is encrypted and still stripped from the response', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await destinations.create(ownerCtx, r2Backups);

      const updated = await destinations.update(
        ownerCtx,
        created.destinationId,
        {
          name: 'renamed',
          bucket: 'other-bucket',
          secretAccessKey: 'rotated-secret-key',
        },
      );
      expect(updated).toMatchObject({
        destinationId: created.destinationId,
        name: 'renamed',
        bucket: 'other-bucket',
        accessKey: 'AKIAEXAMPLEACCESSKEY',
        endpoint: 'https://accountid.r2.cloudflarestorage.com',
      });
      expect(updated).not.toHaveProperty('secretAccessKey');

      const raw = await ctx.db.$client.query<{ secret_access_key: string }>(
        'select secret_access_key from destination where destination_id = $1',
        [created.destinationId],
      );
      expect(raw.rows[0].secret_access_key).not.toContain('rotated-secret-key');
      expect(raw.rows[0].secret_access_key.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('remove', () => {
    it('deletes the destination', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await destinations.create(ownerCtx, r2Backups);

      const removed = await destinations.remove(
        ownerCtx,
        created.destinationId,
      );
      expect(removed.destinationId).toBe(created.destinationId);
      expect(removed).not.toHaveProperty('secretAccessKey');

      await expect(
        destinations.findOne(ownerCtx, created.destinationId),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * A `backup` and a `volume_backup` both reference `destination` with
   * `on delete cascade`, and so does `deployment.backup_id` onto `backup` —
   * so removing a destination a schedule used deleted the schedule and every
   * run recorded against it, while the dialog said nothing else went. The
   * decision is the refusal, the shape a Server still carrying a Service has.
   */
  describe('remove refuses while a backup uses the destination', () => {
    /** A postgres Database in `organizationId`'s first Project. */
    async function insertDatabase(
      userId: string,
      organizationId: string,
      name: string,
    ) {
      const permCtx = permissionCtx(userId, organizationId);
      const project = await ctx.app
        .get(ProjectsService)
        .create(permCtx, { name: `${name}-project` });
      const environment = await ctx.app
        .get(EnvironmentsService)
        .create(permCtx, {
          name: 'production',
          projectId: project.projectId,
        });
      return ctx.app.get(PostgresService).create(permCtx, {
        name,
        appName: name.toLowerCase().replace(/\s+/g, '-'),
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
    }

    /** A destination with a database schedule and a volume backup on it. */
    async function setUpUsedDestination() {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const destination = await destinations.create(ownerCtx, r2Backups);
      const database = await insertDatabase(
        ownerSession.id,
        organizationId,
        'Orders DB',
      );

      const schedule = await request(server)
        .post('/backups')
        .set('Cookie', ownerSession.cookie)
        .send({
          schedule: '0 3 * * *',
          prefix: 'daily',
          database: 'shop',
          databaseType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        });
      expect(schedule.status).toBe(201);

      const volume = await request(server)
        .post('/volume-backups')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'nightly-volume',
          volumeName: 'orders-data',
          prefix: 'volumes',
          schedule: '0 4 * * *',
          serviceType: 'postgres',
          serviceId: database.postgresId,
          destinationId: destination.destinationId,
        });
      expect(volume.status).toBe(201);

      return {
        organizationId,
        ownerSession,
        ownerCtx,
        destination,
        backupId: (schedule.body as { backupId: string }).backupId,
        volumeBackupId: (volume.body as { volumeBackupId: string })
          .volumeBackupId,
      };
    }

    it('answers 409 naming the schedule and the volume backup, and deletes nothing', async () => {
      const { ownerSession, destination, backupId, volumeBackupId } =
        await setUpUsedDestination();

      const refused = await request(server)
        .delete(`/destinations/${destination.destinationId}`)
        .set('Cookie', ownerSession.cookie);

      expect(refused.status).toBe(409);
      const { message } = refused.body as { message: string };
      expect(message).toBe(
        'Destination "prod-backups" is still used by ' +
          `1 backup schedule (schedule "shop on 0 3 * * *" [${backupId}] on postgres "Orders DB") and ` +
          `1 volume backup (volume backup "nightly-volume" [${volumeBackupId}] on postgres "Orders DB"). ` +
          'Removing the destination would delete each of them and every run recorded against them. ' +
          'Point them at another destination or delete them first',
      );

      // Nothing went on the way to being refused.
      const remaining = await ctx.db.$client.query<{ n: string }>(
        `select (select count(*) from destination where destination_id = $1)
              + (select count(*) from backup where backup_id = $2)
              + (select count(*) from volume_backup where volume_backup_id = $3) as n`,
        [destination.destinationId, backupId, volumeBackupId],
      );
      expect(Number(remaining.rows[0].n)).toBe(3);

      // Once both are gone, the same request removes it.
      for (const path of [
        `/backups/${backupId}`,
        `/volume-backups/${volumeBackupId}`,
      ]) {
        const gone = await request(server)
          .delete(path)
          .set('Cookie', ownerSession.cookie);
        expect(gone.status).toBe(200);
      }
      const removed = await request(server)
        .delete(`/destinations/${destination.destinationId}`)
        .set('Cookie', ownerSession.cookie);
      expect(removed.status).toBe(200);
      expect(removed.body).toMatchObject({
        destinationId: destination.destinationId,
      });
    });

    it('reads as absent to another Organization, naming nothing that uses it', async () => {
      const { ownerSession, destination, backupId, volumeBackupId } =
        await setUpUsedDestination();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org', slug: `second-${Date.now()}` },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );

      const refusal = await destinations
        .remove(secondOrgCtx, destination.destinationId)
        .then(
          () => new Error('not refused'),
          (error: Error) => error,
        );
      expect(refusal).toBeInstanceOf(NotFoundException);
      expect(refusal.message).not.toContain(backupId);
      expect(refusal.message).not.toContain(volumeBackupId);
    });

    it('counts a schedule from another Organization without naming it', async () => {
      const { ownerSession, ownerCtx, destination, backupId } =
        await setUpUsedDestination();
      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org', slug: `second-${Date.now()}` },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const foreignDatabase = await insertDatabase(
        ownerSession.id,
        secondOrgId,
        'Their DB',
      );
      // No route writes this row — `BackupsService` resolves the destination
      // org-scoped — so it is inserted, to stand for a row that predates that
      // check. It must still hold the delete, and must not be described.
      const [foreign] = await ctx.db
        .insert(backupTable)
        .values({
          schedule: '0 5 * * *',
          database: 'theirs',
          prefix: 'theirs',
          databaseType: 'postgres',
          postgresId: foreignDatabase.postgresId,
          destinationId: destination.destinationId,
        })
        .returning();

      const refusal = await destinations
        .remove(ownerCtx, destination.destinationId)
        .then(
          () => new Error('not refused'),
          (error: Error) => error,
        );
      expect(refusal).toBeInstanceOf(ConflictException);
      expect(refusal.message).toContain(`2 backup schedules`);
      expect(refusal.message).toContain(backupId);
      expect(refusal.message).toContain('a schedule in another Organization');
      expect(refusal.message).not.toContain(foreign.backupId);
      expect(refusal.message).not.toContain('Their DB');
      expect(refusal.message).not.toContain('theirs');
    });
  });

  describe('cross-org isolation', () => {
    it('a destination is invisible and unremovable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await destinations.create(secondOrgCtx, {
        ...r2Backups,
        name: 'org-b-only',
      });

      // Same user, but acting in the first organization: the destination from
      // the second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        destinations.findOne(firstOrgCtx, foreign.destinationId),
      ).rejects.toThrow(NotFoundException);
      await expect(
        destinations.update(firstOrgCtx, foreign.destinationId, {
          name: 'stolen',
        }),
      ).rejects.toThrow(NotFoundException);
      await expect(
        destinations.remove(firstOrgCtx, foreign.destinationId),
      ).rejects.toThrow(NotFoundException);
      expect(await destinations.list(firstOrgCtx)).toEqual([]);
    });
  });

  describe('testConnection', () => {
    it('issues the rclone probe against the bucket with retry/timeout flags, credentials out of band', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await destinations.testConnection(ownerCtx, r2Backups);

      // The command line carries the probe, never the credentials: it is what
      // gets echoed into failure messages and listed in the process table.
      const [command, options] = execMock.execAsync.mock.calls[0] as [
        string,
        { env?: Record<string, string> },
      ];
      expect(command).toBe(
        'rclone ls --retries 1 --low-level-retries 1 ' +
          '--timeout 10s --contimeout 5s ":s3:cloudgate-backups"',
      );
      // …and rclone still gets every option, through its own environment.
      expect(options.env).toMatchObject({
        RCLONE_S3_PROVIDER: 'Cloudflare',
        RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEACCESSKEY',
        RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
        RCLONE_S3_REGION: 'auto',
        RCLONE_S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
        RCLONE_S3_NO_CHECK_BUCKET: 'true',
        RCLONE_S3_FORCE_PATH_STYLE: 'true',
      });
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('probes from the given server over SSH when serverId is set, credentials in rclone env not argv', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const ours = await insertServer(organizationId);

      await destinations.testConnection(ownerCtx, {
        ...r2Backups,
        serverId: ours.serverId,
      });

      const [serverId, command, , options] = execMock.execAsyncRemote.mock
        .calls[0] as [
        string,
        string,
        ((data: string) => void) | undefined,
        { env?: Record<string, string> },
      ];
      expect(serverId).toBe(ours.serverId);
      // The same probe the local path issues — the remote path has
      // an environment channel of its own now, so the credentials no longer
      // ride along in the command, where the remote host's process table and
      // anything recording its shell history would pick them up.
      expect(command).toBe(
        'rclone ls --retries 1 --low-level-retries 1 ' +
          '--timeout 10s --contimeout 5s ":s3:cloudgate-backups"',
      );
      expect(options.env).toMatchObject({
        RCLONE_S3_PROVIDER: 'Cloudflare',
        RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEACCESSKEY',
        RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
        RCLONE_S3_REGION: 'auto',
        RCLONE_S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
        RCLONE_S3_NO_CHECK_BUCKET: 'true',
        RCLONE_S3_FORCE_PATH_STYLE: 'true',
      });
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    // The bug this fixes. This route's credentials and bucket are the caller's
    // own — the only field on it that names something belonging to this instance
    // is `serverId`, and it went straight to an SSH session. The `void ctx` on
    // the way in was the tell: the caller's organization was on hand, and unread.
    it('refuses a serverId belonging to another organization, and runs nothing', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const theirs = await insertForeignServer(ownerSession.cookie);

      await expect(
        destinations.testConnection(ownerCtx, {
          ...r2Backups,
          serverId: theirs.serverId,
        }),
      ).rejects.toThrow(NotFoundException);

      // Nothing ran on the way to being refused — on their machine or on ours.
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('maps a failed probe to a 400 with the rclone error message', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      execMock.execAsync.mockRejectedValue(
        new Error('AccessDenied: invalid credentials'),
      );

      await expect(
        destinations.testConnection(ownerCtx, r2Backups),
      ).rejects.toThrow(
        new BadRequestException('AccessDenied: invalid credentials'),
      );
    });
  });

  // the refusal from this route is meant to be read by a person, so
  // it must diagnose the failure without ever printing the credentials back.
  describe('POST /destinations/test-connection — refusal never carries the credentials', () => {
    it('refuses with the network diagnosis and not the secret it was given', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      execMock.execAsync.mockImplementation((command: string) =>
        Promise.reject(unreachableEndpoint(command)),
      );

      const probe = await request(server)
        .post('/destinations/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send(wrongSecret);

      expect(probe.status).toBe(400);
      expect(JSON.stringify(probe.body)).not.toContain(
        'WRONG-SECRET-abcdef0123456789',
      );
      expect(JSON.stringify(probe.body)).not.toContain('AKIAEXAMPLEACCESSKEY');
      // The diagnosis is the point of the refusal; redaction must not eat it.
      expect((probe.body as { message: string }).message).toContain(
        'dial tcp: lookup host.docker.internal: no such host',
      );
    });

    // This fixture used to put the key in `AWSAccessKeyId: '…'` and the
    // secret in `signing key derived from '…'`, and rclone writes neither —
    // `aws-sdk-go` keeps `Code` and `Message` from an S3 error body and discards
    // the remainder, and it certainly never echoes a signing key. What rclone
    // *does* name in every transport failure is the URL it dialled, and
    // `Destination.endpoint` is a free string an operator can paste credentials
    // into.
    //
    // The fix for the URL leak then reintroduced the same class of mistake it removed:
    // it kept the `SignatureDoesNotMatch` / `status code: 403` half of the old
    // message and hung the dialled URL off it under a `caused by:` line. Those
    // are two different `awserr` values — one parsed out of a response body, one
    // wrapping a `*url.Error` from a connection that was never made — and no
    // rclone run can emit both. `dialledEndpointRefused` and
    // `S3_REFUSAL_NO_CREDENTIAL` are the two shapes as measured, one per test.
    it('strips the access key out of the endpoint rclone names, keeping the rest of the refusal', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      // What rclone dials when the pasted endpoint below is resolved: the key
      // survives as the URL's username, the secret is `***` before we see it.
      const url =
        'http://AKIAEXAMPLEACCESSKEY:***@host.docker.internal:9000/cloudgate-backups' +
        '?delimiter=&max-keys=1000&prefix=';
      execMock.execAsync.mockRejectedValue(dialledEndpointRefused(url));

      const probe = await request(server)
        .post('/destinations/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send({
          ...wrongSecret,
          endpoint:
            'http://AKIAEXAMPLEACCESSKEY:WRONG-SECRET-abcdef0123456789@host.docker.internal:9000',
        });

      expect(probe.status).toBe(400);
      const { message } = probe.body as { message: string };
      expect(message).not.toContain('AKIAEXAMPLEACCESSKEY');
      // Vacuous by construction — Go blanked the password long before the mask
      // ran — and kept as a cheap invariant, not as evidence.
      expect(message).not.toContain('WRONG-SECRET-abcdef0123456789');
      // The load-bearing one: the mask fired exactly where the key was and left
      // the URL otherwise readable, so the operator can still see which endpoint
      // was dialled.
      expect(message).toContain('http://••••••:***@host.docker.internal:9000');
      // And the diagnosis the refusal exists to carry survives the redaction.
      expect(message).toContain('RequestError: send request failed');
      expect(message).toContain('dial tcp: connection refused');
    });

    // The other half of the message the spliced fixture was asserting, on the
    // error that can actually carry it. Nothing to redact here — a parsed S3
    // refusal names no URL — so this pins the opposite guarantee: the mask, and
    // the `rcloneFailureMessage` picking below it, must not eat the diagnosis.
    it('relays a genuine S3 refusal whole, which is the shape that carries no credential', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      execMock.execAsync.mockRejectedValue(new Error(S3_REFUSAL_NO_CREDENTIAL));

      const probe = await request(server)
        .post('/destinations/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send(wrongSecret);

      expect(probe.status).toBe(400);
      const { message } = probe.body as { message: string };
      expect(message).toContain('SignatureDoesNotMatch');
      expect(message).toContain('Check your key and signing method.');
      expect(message).toContain('status code: 403');
      // The credential is not in this shape to begin with; asserted so that a
      // future fixture cannot quietly put it back.
      expect(message).not.toContain('AKIAEXAMPLEACCESSKEY');
      expect(message).not.toContain('WRONG-SECRET-abcdef0123456789');
    });

    it('refuses the same way when the probe ran on a remote server over SSH', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ours = await insertServer(organizationId);
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.reject(unreachableEndpoint(command)),
      );

      const probe = await request(server)
        .post('/destinations/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send({ ...wrongSecret, serverId: ours.serverId });

      expect(probe.status).toBe(400);
      expect(JSON.stringify(probe.body)).not.toContain(
        'WRONG-SECRET-abcdef0123456789',
      );
      expect(JSON.stringify(probe.body)).not.toContain('AKIAEXAMPLEACCESSKEY');
      expect((probe.body as { message: string }).message).toContain(
        'dial tcp: lookup host.docker.internal: no such host',
      );
    });

    // And it has to read that diagnosis off the right field. The test
    // above rejects with the shape `child_process` builds — the command line and
    // then rclone's output, all inside `message` — which is what a probe with no
    // `serverId` gets. Over SSH there is no such folding.
    it('reads the reason off stderr when the probe ran over SSH, where nothing folds it into the message', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ours = await insertServer(organizationId);
      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.reject(unreachableEndpointOverSsh(command)),
      );

      const probe = await request(server)
        .post('/destinations/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send({ ...wrongSecret, serverId: ours.serverId });

      expect(probe.status).toBe(400);
      const { message } = probe.body as { message: string };
      expect(message).toContain(
        'dial tcp: lookup host.docker.internal: no such host',
      );
      // The exit code is not an answer: this is the sentence the route used to
      // give a Server-scoped probe, with the reason left in a field nobody read.
      expect(message).not.toBe('Remote command failed with exit code 1');
      expect(message).not.toContain('WRONG-SECRET-abcdef0123456789');
    });
  });

  // `POST /destinations/test-connection` takes the whole payload, and
  // the secret never comes back on a read — so a destination whose bucket policy
  // changed under it could not be re-checked from the console at all. The
  // id-taking variant loads the row's decrypted credentials server-side, the
  // same lookup a scheduled backup already does.
  describe('POST /destinations/:id/test-connection — testing a saved destination', () => {
    it('probes the stored bucket with the stored credentials, out of band', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/destinations')
        .set('Cookie', ownerSession.cookie)
        .send(r2Backups);
      expect(created.status).toBe(201);
      const { destinationId } = created.body as { destinationId: string };

      const probe = await request(server)
        .post(`/destinations/${destinationId}/test-connection`)
        .set('Cookie', ownerSession.cookie);
      expect(probe.status).toBe(204);

      const [command, options] = execMock.execAsync.mock.calls[0] as [
        string,
        { env?: Record<string, string> },
      ];
      expect(command).toBe(
        'rclone ls --retries 1 --low-level-retries 1 ' +
          '--timeout 10s --contimeout 5s ":s3:cloudgate-backups"',
      );
      // The secret is the one at rest, decrypted on the way out of the driver
      // — the browser never held it and did not send it.
      expect(options.env).toMatchObject({
        RCLONE_S3_PROVIDER: 'Cloudflare',
        RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEACCESSKEY',
        RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
        RCLONE_S3_REGION: 'auto',
        RCLONE_S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
      });
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      // Nothing comes back — and so nothing can carry the secret back.
      expect(probe.text).toBe('');
    });

    it('probes from the given server over SSH when a serverId is sent', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ours = await insertServer(organizationId);

      const created = await request(server)
        .post('/destinations')
        .set('Cookie', ownerSession.cookie)
        .send(r2Backups);
      const { destinationId } = created.body as { destinationId: string };

      const probe = await request(server)
        .post(`/destinations/${destinationId}/test-connection`)
        .set('Cookie', ownerSession.cookie)
        .send({ serverId: ours.serverId });
      expect(probe.status).toBe(204);

      const [serverId, , , options] = execMock.execAsyncRemote.mock
        .calls[0] as [
        string,
        string,
        ((data: string) => void) | undefined,
        { env?: Record<string, string> },
      ];
      expect(serverId).toBe(ours.serverId);
      expect(options.env).toMatchObject({
        RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
      });
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    // The sharp edge of the whole issue: on this route the caller never sent
    // the secret, so it cannot redact the refusal itself (the client-side
    // pass has nothing to match on). The server has to.
    it('refuses with rclone diagnosis and never the stored secret', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      // The endpoint carries the credentials, because that is the only way one
      // can reach this route's refusal at all — the caller sent nothing.
      const created = await request(server)
        .post('/destinations')
        .set('Cookie', ownerSession.cookie)
        .send(r2BackupsWithPastedCredentials);
      const { destinationId } = created.body as { destinationId: string };

      // The URL rclone dialled, not a body it cannot relay — see
      // `dialledEndpointRefused`. The secret assertion below is vacuous by
      // construction and kept as a cheap invariant.
      execMock.execAsync.mockRejectedValue(
        dialledEndpointRefused(r2DialledUrl),
      );

      const probe = await request(server)
        .post(`/destinations/${destinationId}/test-connection`)
        .set('Cookie', ownerSession.cookie);
      expect(probe.status).toBe(400);

      const { message } = probe.body as { message: string };
      expect(message).not.toContain('AKIAEXAMPLEACCESSKEY');
      expect(message).not.toContain('wJalrXUtnFEMI-example-secret-key');
      // The key came off the row, not off the request, and it is masked anyway.
      expect(message).toContain(
        'https://••••••:***@accountid.r2.cloudflarestorage.com',
      );
      expect(message).toContain('RequestError: send request failed');
      expect(message).toContain('dial tcp: connection refused');
    });

    it('an id from another Organization reads as absent', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );
      const foreign = await destinations.create(secondOrgCtx, r2Backups);

      const probe = await request(server)
        .post(`/destinations/${foreign.destinationId}/test-connection`)
        .set('Cookie', ownerSession.cookie);
      expect(probe.status).toBe(404);
      expect(execMock.execAsync).not.toHaveBeenCalled();

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        destinations.testSavedConnection(
          firstOrgCtx,
          foreign.destinationId,
          {},
        ),
      ).rejects.toThrow(NotFoundException);
    });

    // The second half of the fix: the destination id above is org-scoped and the
    // `serverId` beside it was not. Two unrelated fields of one request, so
    // resolving the destination says nothing about the machine — a caller who
    // owns the destination could still name any Server on the instance.
    it('refuses a serverId belonging to another organization, and runs nothing', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const ours = await destinations.create(ownerCtx, r2Backups);
      const theirs = await insertForeignServer(ownerSession.cookie);

      const probe = await request(server)
        .post(`/destinations/${ours.destinationId}/test-connection`)
        .set('Cookie', ownerSession.cookie)
        .send({ serverId: theirs.serverId });
      expect(probe.status).toBe(404);

      await expect(
        destinations.testSavedConnection(ownerCtx, ours.destinationId, {
          serverId: theirs.serverId,
        }),
      ).rejects.toThrow(NotFoundException);

      // Nothing ran on the way to being refused — on their machine or on ours.
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    // Both routes still answer for the platform host, which is the branch the
    // shared lookup resolves to `undefined` for rather than refusing (ADR-0008).
    it('still probes the platform host when the serverId is absent or null', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const saved = await destinations.create(ownerCtx, r2Backups);

      await destinations.testConnection(ownerCtx, {
        ...r2Backups,
        serverId: null,
      });
      await destinations.testSavedConnection(ownerCtx, saved.destinationId, {
        serverId: null,
      });
      await destinations.testSavedConnection(ownerCtx, saved.destinationId, {});

      expect(execMock.execAsync).toHaveBeenCalledTimes(3);
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('the payload-taking route is untouched — a bucket is still provable before it is saved', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const probe = await request(server)
        .post('/destinations/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send(r2Backups);
      expect(probe.status).toBe(204);
      expect(execMock.execAsync).toHaveBeenCalledTimes(1);

      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      expect(await destinations.list(ownerCtx)).toEqual([]);
    });
  });

  // a volume backup cannot be restored from the UI until something
  // enumerates the tarballs a destination holds — the keys are derivable but
  // pruning means they are not guessable.
  describe('listObjects', () => {
    /** An rclone lsjson listing of one app's backup prefix, dirs included. */
    const lsjson = JSON.stringify([
      {
        Path: 'daily/2026-08-01T02-00-00-000Z.tgz',
        Name: '2026-08-01T02-00-00-000Z.tgz',
        Size: 1024,
        ModTime: '2026-08-01T02:00:04.000Z',
        IsDir: false,
      },
      {
        Path: 'daily',
        Name: 'daily',
        Size: -1,
        ModTime: '2026-08-06T02:00:05.000Z',
        IsDir: true,
      },
      {
        Path: 'daily/2026-08-06T02-00-00-000Z.tgz',
        Name: '2026-08-06T02-00-00-000Z.tgz',
        Size: 2048,
        ModTime: '2026-08-06T02:00:05.000Z',
        IsDir: false,
      },
    ]);

    it('lists the objects under a prefix newest first, keys destination-relative, credentials out of argv', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await destinations.create(ownerCtx, r2Backups);

      execMock.execAsync.mockResolvedValue({ stdout: lsjson, stderr: '' });

      const objects = await destinations.listObjects(
        ownerCtx,
        created.destinationId,
        { prefix: 'storefront' },
      );

      // Newest first — which tarball is the newest one is the whole decision a
      // restore makes — and the directory entry is not an object.
      expect(objects).toEqual([
        {
          key: 'storefront/daily/2026-08-06T02-00-00-000Z.tgz',
          size: 2048,
          lastModified: '2026-08-06T02:00:05.000Z',
        },
        {
          key: 'storefront/daily/2026-08-01T02-00-00-000Z.tgz',
          size: 1024,
          lastModified: '2026-08-01T02:00:04.000Z',
        },
      ]);

      const [command, options] = execMock.execAsync.mock.calls[0] as [
        string,
        { env?: Record<string, string> },
      ];
      expect(command).toBe(
        'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s --contimeout 5s --recursive --no-mimetype ":s3:cloudgate-backups/storefront/"',
      );
      expect(command).not.toContain('--s3-secret-access-key');
      expect(options.env).toMatchObject({
        RCLONE_S3_PROVIDER: 'Cloudflare',
        RCLONE_S3_ACCESS_KEY_ID: 'AKIAEXAMPLEACCESSKEY',
        RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
        RCLONE_S3_ENDPOINT: 'https://accountid.r2.cloudflarestorage.com',
      });
    });

    // Two of the three bucket-reading routes honour a `serverId` and
    // this one did not — and its DTO had no such field, so the parameter was
    // dropped by validation and the listing answered from the platform host as
    // if it had been honoured. On a real multi-server instance the restore
    // picker and the restore itself then read different machines.
    it('lists from the given server over SSH when a serverId is sent', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await destinations.create(ownerCtx, r2Backups);
      const [own] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'edge-1',
          ipAddress: '203.0.113.30',
          port: 22,
          organizationId,
        })
        .returning();

      execMock.execAsyncRemote.mockResolvedValue({
        stdout: '[]',
        stderr: '',
        exitCode: 0,
      });

      expect(
        await destinations.listObjects(ownerCtx, created.destinationId, {
          serverId: own.serverId,
        }),
      ).toEqual([]);

      const [serverId, command, , options] = execMock.execAsyncRemote.mock
        .calls[0] as [
        string,
        string,
        ((data: string) => void) | undefined,
        { env?: Record<string, string> },
      ];
      expect(serverId).toBe(own.serverId);
      expect(command).toContain('rclone lsjson');
      expect(command).not.toContain('--s3-secret-access-key');
      expect(options.env).toMatchObject({
        RCLONE_S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI-example-secret-key',
      });
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    // The destination is org-scoped by the read above it, but the Server the
    // caller names decides which machine runs rclone *with that destination's
    // credentials* — so it has to be scoped too. `GET /backups/files`, the
    // sibling the earlier report cites as already honouring `serverId`, scopes it with the
    // same lookup; this route copied the parameter without the check until the
    // review caught it.
    it('refuses a serverId belonging to another organization, and runs nothing', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await destinations.create(ownerCtx, r2Backups);

      const theirs = await insertForeignServer(ownerSession.cookie);

      await expect(
        destinations.listObjects(ownerCtx, created.destinationId, {
          serverId: theirs.serverId,
        }),
      ).rejects.toThrow(NotFoundException);

      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    // The first half of the fix: validation used to strip `serverId` out of the
    // query, so the route answered from the platform host however the caller
    // asked. This calls the zod schema directly — no app, no database, no
    // organization check — so the id is a string being parsed and a `server`
    // row would be unreachable from here. The scoping half is proved by
    // the refusal test above, on a real row in another Organization.
    it('takes the serverId off the query rather than dropping it', () => {
      expect(
        listDestinationObjectsSchema.parse({
          prefix: 'storefront',
          serverId: 'server-1',
        }),
      ).toEqual({ prefix: 'storefront', serverId: 'server-1' });
    });

    it('lists the whole bucket when no prefix is given', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await destinations.create(ownerCtx, r2Backups);

      execMock.execAsync.mockResolvedValue({ stdout: '[]', stderr: '' });

      expect(
        await destinations.listObjects(ownerCtx, created.destinationId, {}),
      ).toEqual([]);

      const [command] = execMock.execAsync.mock.calls[0] as [string];
      expect(command).toBe(
        'rclone lsjson --retries 1 --low-level-retries 1 --timeout 30s --contimeout 5s --recursive --no-mimetype ":s3:cloudgate-backups"',
      );
    });

    // Found by driving the picker against a destination whose MinIO was not
    // running: rclone's defaults (3 retries, 10 low-level retries, a 1m connect
    // timeout) kept the request open past 30s and answered nothing, so the
    // first step of a restore hangs with no feedback. testConnection has always
    // bounded its probe; this listing did not.
    it('bounds the listing so a destination that is not there refuses rather than hangs', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await destinations.create(ownerCtx, r2Backups);

      execMock.execAsync.mockResolvedValue({ stdout: '[]', stderr: '' });
      await destinations.listObjects(ownerCtx, created.destinationId, {});

      const [command] = execMock.execAsync.mock.calls[0] as [string];
      expect(command).toContain('--retries 1');
      expect(command).toContain('--low-level-retries 1');
      expect(command).toContain('--contimeout 5s');
      expect(command).toContain('--timeout 30s');
    });

    it('refuses with rclone words when the listing fails, and without the credentials', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      // Same as the saved-probe refusal next door: the listing sends no
      // credentials either, so the endpoint is where one has to have come from.
      const created = await destinations.create(
        ownerCtx,
        r2BackupsWithPastedCredentials,
      );

      // The URL rclone dialled, not a body it cannot relay — see
      // `dialledEndpointRefused`. The secret assertion below is vacuous by
      // construction and kept as a cheap invariant.
      execMock.execAsync.mockRejectedValue(
        dialledEndpointRefused(r2DialledUrl, 'lsjson'),
      );

      const refusal = destinations.listObjects(
        ownerCtx,
        created.destinationId,
        {},
      );
      await expect(refusal).rejects.toThrow(BadRequestException);
      const message = await refusal.catch((error: Error) => error.message);
      expect(message).not.toContain('AKIAEXAMPLEACCESSKEY');
      expect(message).not.toContain('wJalrXUtnFEMI-example-secret-key');
      expect(message).toContain(
        'https://••••••:***@accountid.r2.cloudflarestorage.com',
      );
      expect(message).toContain('RequestError: send request failed');
      expect(message).toContain('dial tcp: connection refused');
    });

    // The same listing, run on the Server the caller named. `execRclone`
    // rejects with the SSH shape there — a flat `Remote command failed with exit
    // code 1` and the diagnosis in `stderr` — so reading `error.message` answered
    // the exit code and nothing else.
    it('refuses with rclone words when the listing ran over SSH', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await destinations.create(ownerCtx, r2Backups);
      const ours = await insertServer(organizationId);

      execMock.execAsyncRemote.mockImplementation(
        (_serverId: string, command: string) =>
          Promise.reject(unreachableEndpointOverSsh(command)),
      );

      const refusal = destinations.listObjects(
        ownerCtx,
        created.destinationId,
        {
          serverId: ours.serverId,
        },
      );
      await expect(refusal).rejects.toThrow(BadRequestException);
      const message = await refusal.catch((error: Error) => error.message);
      expect(message).toContain(
        'dial tcp: lookup host.docker.internal: no such host',
      );
      expect(message).not.toBe('Remote command failed with exit code 1');
      expect(message).not.toContain('wJalrXUtnFEMI-example-secret-key');
    });

    it('refuses when rclone answers with something that is not a listing', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const created = await destinations.create(ownerCtx, r2Backups);

      execMock.execAsync.mockResolvedValue({
        stdout: 'rclone: command not found',
        stderr: '',
      });

      await expect(
        destinations.listObjects(ownerCtx, created.destinationId, {}),
      ).rejects.toThrow(BadRequestException);
    });

    it('does not list a destination belonging to another organization', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const foreign = await destinations.create(
        permissionCtx(ownerSession.id, secondOrgId),
        r2Backups,
      );

      const orgs = await request(server)
        .get('/organizations')
        .set('Cookie', ownerSession.cookie);
      const firstOrgId = (orgs.body as { id: string }[])[0].id;

      await expect(
        destinations.listObjects(
          permissionCtx(ownerSession.id, firstOrgId),
          foreign.destinationId,
          {},
        ),
      ).rejects.toThrow(NotFoundException);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('serves the listing over GET /destinations/:id/objects', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/destinations')
        .set('Cookie', cookie)
        .send(r2Backups);
      const id = (created.body as { destinationId: string }).destinationId;

      execMock.execAsync.mockResolvedValue({ stdout: lsjson, stderr: '' });

      const listed = await request(server)
        .get(`/destinations/${id}/objects`)
        .query({ prefix: 'storefront' })
        .set('Cookie', cookie);

      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([
        {
          key: 'storefront/daily/2026-08-06T02-00-00-000Z.tgz',
          size: 2048,
          lastModified: '2026-08-06T02:00:05.000Z',
        },
        {
          key: 'storefront/daily/2026-08-01T02-00-00-000Z.tgz',
          size: 1024,
          lastModified: '2026-08-01T02:00:04.000Z',
        },
      ]);

      // The query string's serverId reaches the exec rather than being
      // dropped by validation and answered from the platform host anyway.
      execMock.execAsyncRemote.mockResolvedValue({
        stdout: '[]',
        stderr: '',
        exitCode: 0,
      });
      const [own] = await ctx.db
        .insert(serverTable)
        .values({
          name: 'edge-http',
          ipAddress: '203.0.113.32',
          port: 22,
          organizationId,
        })
        .returning();
      const fromServer = await request(server)
        .get(`/destinations/${id}/objects`)
        .query({ prefix: 'storefront', serverId: own.serverId })
        .set('Cookie', cookie);
      expect(fromServer.status).toBe(200);
      expect(fromServer.body).toEqual([]);
      const [ranOn] = execMock.execAsyncRemote.mock.calls[0] as [string];
      expect(ranOn).toBe(own.serverId);

      // ...and a Server this organization does not own is a 404, not a listing
      // run on somebody else's machine with this destination's credentials.
      //
      // A real row in a second Organization, not the `serverId: 'server-1'` that
      // used to stand here. `checkServerAccess` runs one
      // `serverId = ? AND organizationId = ?` select and raises the same
      // NotFound whichever predicate misses, so an id nothing owns fails on the
      // id alone and the 404 above it proved nothing about the organization
      // check — which is how the cross-org hole survived a green suite.
      // The message is asserted for the neighbouring conflation: this route
      // reads the destination first, and 'Destination not found' here would
      // mean the Server was never reached at all.
      const theirs = await insertForeignServer(cookie);
      const refused = await request(server)
        .get(`/destinations/${id}/objects`)
        .query({ prefix: 'storefront', serverId: theirs.serverId })
        .set('Cookie', cookie);
      expect(refused.status).toBe(404);
      expect((refused.body as { message: string }).message).toBe(
        'Server not found',
      );
      // Nothing ran on their machine. The owned listing above already holds the
      // only remote call, so this counts rather than asserting never-called.
      expect(execMock.execAsyncRemote).toHaveBeenCalledTimes(1);

      const missing = await request(server)
        .get('/destinations/does-not-exist/objects')
        .set('Cookie', cookie);
      expect(missing.status).toBe(404);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip plus test-connection over HTTP, never leaking the secret', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/destinations')
        .set('Cookie', cookie)
        .send(r2Backups);
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty('secretAccessKey');
      const id = (created.body as { destinationId: string }).destinationId;

      const rejected = await request(server)
        .post('/destinations')
        .set('Cookie', cookie)
        .send({ ...r2Backups, name: '' });
      expect(rejected.status).toBe(400);

      const probe = await request(server)
        .post('/destinations/test-connection')
        .set('Cookie', cookie)
        .send(r2Backups);
      expect(probe.status).toBe(204);
      expect(execMock.execAsync).toHaveBeenCalledWith(
        expect.stringContaining('rclone ls'),
        expect.objectContaining({ env: expect.any(Object) as object }),
      );

      const listed = await request(server)
        .get('/destinations')
        .set('Cookie', cookie);
      expect(listed.status).toBe(200);
      const listedBody = listed.body as { name: string }[];
      expect(listedBody.map((d) => d.name)).toEqual(['prod-backups']);
      expect(listedBody[0]).not.toHaveProperty('secretAccessKey');

      const one = await request(server)
        .get(`/destinations/${id}`)
        .set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'prod-backups',
        bucket: 'cloudgate-backups',
        provider: 'Cloudflare',
      });
      expect(one.body).not.toHaveProperty('secretAccessKey');

      const patched = await request(server)
        .patch(`/destinations/${id}`)
        .set('Cookie', cookie)
        .send({ name: 'renamed' });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({
        name: 'renamed',
        bucket: 'cloudgate-backups',
      });
      expect(patched.body).not.toHaveProperty('secretAccessKey');

      const removed = await request(server)
        .delete(`/destinations/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server)
        .get(`/destinations/${id}`)
        .set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });
  });
});
