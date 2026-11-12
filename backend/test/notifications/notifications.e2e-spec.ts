import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { BackupsService } from '../../src/backups/backups.service';
import { PostgresService } from '../../src/databases/postgres/postgres.service';
import {
  DEPLOYMENT_NOTIFIER,
  DeploymentNotifier,
} from '../../src/deployment-engine/ports/deployment-notifier';
import { DestinationsService } from '../../src/destinations/destinations.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { SmtpSender } from '../../src/mail/senders/smtp';
import { ResendSender } from '../../src/mail/senders/resend';
// Imported rather than typed out on purpose, and the distinction is §1.7's:
// what these cases pin is that the *route* delivers the probe, not what the
// probe says. The wording itself is pinned once, written out, in
// `channel-strategies.spec.ts` beside the census that holds it to one copy —
// retyping it here would put a second copy of it in a file that census does
// not scan, which is the census bug again.
import {
  TEST_MESSAGE,
  TEST_TITLE,
} from '../../src/notifications/channels/channel.strategy';
import { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import {
  channelRelations,
  notification,
} from '../../src/notifications/notification.schema';
import {
  NotificationsService,
  SanitizedNotification,
} from '../../src/notifications/notifications.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionCtx } from '../../src/rbac/permission.service';
import { ExecError } from '../../src/remote/exec-error';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  defaultMetricsConfig,
  server as serverTable,
} from '../../src/servers/server.schema';
import {
  defaultWebServerMetricsConfig,
  webServerSettings,
} from '../../src/settings/settings.schema';
import { VolumeBackupsService } from '../../src/volume-backups/volume-backups.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { createOrganization } from '../utils/test-auth';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** All event flags off unless a test opts in. */
const flagsOff = {
  appDeploy: false,
  appBuildError: false,
  databaseBackup: false,
  volumeBackup: false,
  instanceBackup: false,
  instanceRestart: false,
  dockerCleanup: false,
  serverThreshold: false,
  licenseLapse: false,
  licenseExpiring: false,
  agentRateLimited: false,
  previewTeardownStuck: false,
  serviceIncident: false,
  aiModelNotAnswering: false,
};

const slackChannel = {
  ...flagsOff,
  name: 'deploys-slack',
  appDeploy: true,
  webhookUrl: 'https://hooks.slack.com/services/T000/B000/SECRETTOKEN',
  channel: '#deploys',
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

describe('Notifications (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let notifications: NotificationsService;

  // Every channel delivery is a system boundary: webhooks/HTTP APIs go
  // through the shared fetch client, email through the mail senders.
  const fetchMock = jest.fn();
  const smtpMock = { send: jest.fn() };
  const resendMock = { send: jest.fn() };
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: FETCH_CLIENT, useValue: fetchMock },
        { provide: SmtpSender, useValue: smtpMock },
        { provide: ResendSender, useValue: resendMock },
        { provide: RemoteExecService, useValue: execMock },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    notifications = ctx.app.get(NotificationsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
    smtpMock.send.mockReset().mockResolvedValue(undefined);
    resendMock.send.mockReset().mockResolvedValue(undefined);
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  /**
   * The hydrated row as the dispatcher reads it — connection credentials
   * decrypted. The service API projects them away, so the
   * round-trip through `encryptedText` is checked at the db seam instead.
   */
  const storedChannels = async (notificationId: string) => {
    const row = await ctx.db.query.notification.findFirst({
      where: eq(notification.notificationId, notificationId),
      with: channelRelations,
    });
    if (!row) throw new Error(`no notification ${notificationId}`);
    return row;
  };

  /** The slack attachment posted by the given fetch call. */
  const slackAttachment = (call = 0) => {
    const [, init] = fetchMock.mock.calls[call] as [string, { body: string }];
    const body = JSON.parse(init.body) as {
      attachments: {
        pretext: string;
        fields: { title: string; value: string }[];
      }[];
    };
    return body.attachments[0];
  };

  describe('slack channel CRUD', () => {
    it('creates a slack notification retrievable by id, webhook encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createSlack(ownerCtx, slackChannel);

      expect(created.notificationId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);
      expect(created.notificationType).toBe('slack');
      expect(created.appDeploy).toBe(true);
      expect(created.appBuildError).toBe(false);

      const found = await notifications.findOne(
        ownerCtx,
        created.notificationId,
      );
      expect(found).toMatchObject({
        notificationId: created.notificationId,
        name: 'deploys-slack',
        notificationType: 'slack',
        appDeploy: true,
        organizationId,
      });
      expect(found.slack).toMatchObject({ channel: '#deploys' });

      // The webhook is stored encrypted and decrypts on read for the
      // dispatcher; the API projection is what keeps it off the wire.
      const stored = await storedChannels(created.notificationId);
      expect(stored.slack?.webhookUrl).toBe(
        'https://hooks.slack.com/services/T000/B000/SECRETTOKEN',
      );

      const raw = await ctx.db.$client.query<{ webhook_url: string }>(
        'select webhook_url from slack where slack_id = $1',
        [found.slack!.slackId],
      );
      expect(raw.rows[0].webhook_url).not.toContain('SECRETTOKEN');
      expect(raw.rows[0].webhook_url.startsWith('enc:v1:')).toBe(true);
    });
  });

  // The flag is what makes the lapse warning deliverable at all: the
  // dispatcher loads rows where this column is true, so a channel that cannot
  // set it over HTTP is a channel that can never be told. An event flag the DTO
  // does not declare is stripped by the validation pipe and reads back false,
  // which is the failure this pins.
  describe('opting a channel into the license-lapse event', () => {
    it('accepts the flag over HTTP and reads it back', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/slack')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'licence-watch',
          webhookUrl: 'https://hooks.slack.com/services/T/B/LAPSE',
          channel: '#ops',
          licenseLapse: true,
        });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        licenseLapse: true,
        appDeploy: false,
      });

      const listed = await request(server)
        .get('/notifications')
        .set('Cookie', ownerSession.cookie);
      expect(listed.body).toEqual([
        expect.objectContaining({ licenseLapse: true }),
      ]);
    });

    it('defaults the flag off, so an existing channel stays silent about it', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/slack')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'deploys-only',
          webhookUrl: 'https://hooks.slack.com/services/T/B/X',
          appDeploy: true,
        });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ licenseLapse: false });
    });
  });

  // The 14- and 3-day warnings ride their own flag, next to the lapse's.
  describe('opting a channel into the license-expiring event', () => {
    it('accepts the flag over HTTP and reads it back, independent of the lapse', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/slack')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'licence-renewals',
          webhookUrl: 'https://hooks.slack.com/services/T/B/EXPIRING',
          channel: '#ops',
          licenseExpiring: true,
        });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        licenseExpiring: true,
        licenseLapse: false,
      });

      const listed = await request(server)
        .get('/notifications')
        .set('Cookie', ownerSession.cookie);
      expect(listed.body).toEqual([
        expect.objectContaining({ licenseExpiring: true }),
      ]);
    });

    it('defaults the flag off', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/slack')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'deploys-only',
          webhookUrl: 'https://hooks.slack.com/services/T/B/X',
          appDeploy: true,
        });

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ licenseExpiring: false });
    });
  });

  describe('telegram channel', () => {
    it('creates a telegram notification, bot token encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createTelegram(ownerCtx, {
        ...flagsOff,
        name: 'ops-telegram',
        appBuildError: true,
        botToken: '123456:ABC-BOTSECRET',
        chatId: '-1001234567890',
        messageThreadId: '42',
      });
      expect(created.notificationType).toBe('telegram');

      const found = await notifications.findOne(
        ownerCtx,
        created.notificationId,
      );
      expect(found.telegram).toMatchObject({
        chatId: '-1001234567890',
        messageThreadId: '42',
      });

      const stored = await storedChannels(created.notificationId);
      expect(stored.telegram?.botToken).toBe('123456:ABC-BOTSECRET');

      const raw = await ctx.db.$client.query<{ bot_token: string }>(
        'select bot_token from telegram where telegram_id = $1',
        [found.telegram!.telegramId],
      );
      expect(raw.rows[0].bot_token).not.toContain('BOTSECRET');
      expect(raw.rows[0].bot_token.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('discord channel', () => {
    it('creates a discord notification, webhook encrypted at rest', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createDiscord(ownerCtx, {
        ...flagsOff,
        name: 'alerts-discord',
        databaseBackup: true,
        webhookUrl: 'https://discord.com/api/webhooks/1/DISCORDSECRET',
        decoration: true,
      });
      expect(created.notificationType).toBe('discord');

      const found = await notifications.findOne(
        ownerCtx,
        created.notificationId,
      );
      expect(found.discord).toMatchObject({ decoration: true });

      const stored = await storedChannels(created.notificationId);
      expect(stored.discord?.webhookUrl).toBe(
        'https://discord.com/api/webhooks/1/DISCORDSECRET',
      );

      const raw = await ctx.db.$client.query<{ webhook_url: string }>(
        'select webhook_url from discord where discord_id = $1',
        [found.discord!.discordId],
      );
      expect(raw.rows[0].webhook_url).not.toContain('DISCORDSECRET');
      expect(raw.rows[0].webhook_url.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('remaining channels', () => {
    /**
     * One channel's fixture: the payload its connection row is built from,
     * plus the call that creates it. `create` binds each payload to its own
     * service method instead of indexing the service by a union of method
     * names — TypeScript resolves a call on a union of signatures against the
     * *intersection* of their parameters, so `notifications[method](…)` would
     * demand a single body satisfying all nine Create*Dto at once.
     */
    type ChannelCase = {
      /** The connection table, and the key it is hydrated onto. */
      type: keyof typeof channelRelations;
      /** The connection the stored row must round-trip. */
      payload: Record<string, unknown>;
      /** The column the credential is encrypted into. */
      secretColumn: string;
      /** Plaintext that must not survive to rest. */
      plaintext: string;
      create: (
        permCtx: PermissionCtx,
        name: string,
      ) => Promise<SanitizedNotification>;
    };

    const emailConnection = {
      smtpServer: 'smtp.example.com',
      smtpPort: 587,
      username: 'mailer',
      password: 'SMTPPASSWORD',
      fromAddress: 'noreply@example.com',
      toAddresses: ['ops@example.com', 'dev@example.com'],
    };
    const resendConnection = {
      apiKey: 're_RESENDSECRET',
      fromAddress: 'noreply@example.com',
      toAddresses: ['ops@example.com'],
    };
    const gotifyConnection = {
      serverUrl: 'https://gotify.example.com',
      appToken: 'GOTIFYTOKEN',
      priority: 5,
      decoration: true,
    };
    const ntfyConnection = {
      serverUrl: 'https://ntfy.sh',
      topic: 'cloudgate-alerts',
      accessToken: 'NTFYTOKEN',
      priority: 3,
    };
    const mattermostConnection = {
      webhookUrl: 'https://mm.example.com/hooks/MMSECRET',
      channel: 'town-square',
      username: 'cloudgate',
    };
    const customConnection = {
      endpoint: 'https://internal.example.com/hook?key=CUSTOMSECRET',
      headers: { 'X-Api-Key': 'abc' },
    };
    const larkConnection = {
      webhookUrl: 'https://open.larksuite.com/bot/v2/hook/LARKSECRET',
    };
    const pushoverConnection = {
      userKey: 'PUSHOVERUSER',
      apiToken: 'PUSHOVERTOKEN',
      priority: 1,
    };
    const teamsConnection = {
      webhookUrl: 'https://outlook.office.com/webhook/TEAMSSECRET',
    };

    const cases: ChannelCase[] = [
      {
        type: 'email',
        payload: emailConnection,
        secretColumn: 'password',
        plaintext: 'SMTPPASSWORD',
        create: (permCtx, name) =>
          notifications.createEmail(permCtx, {
            ...flagsOff,
            name,
            ...emailConnection,
          }),
      },
      {
        type: 'resend',
        payload: resendConnection,
        secretColumn: 'api_key',
        plaintext: 'RESENDSECRET',
        create: (permCtx, name) =>
          notifications.createResend(permCtx, {
            ...flagsOff,
            name,
            ...resendConnection,
          }),
      },
      {
        type: 'gotify',
        payload: gotifyConnection,
        secretColumn: 'app_token',
        plaintext: 'GOTIFYTOKEN',
        create: (permCtx, name) =>
          notifications.createGotify(permCtx, {
            ...flagsOff,
            name,
            ...gotifyConnection,
          }),
      },
      {
        type: 'ntfy',
        payload: ntfyConnection,
        secretColumn: 'access_token',
        plaintext: 'NTFYTOKEN',
        create: (permCtx, name) =>
          notifications.createNtfy(permCtx, {
            ...flagsOff,
            name,
            ...ntfyConnection,
          }),
      },
      {
        type: 'mattermost',
        payload: mattermostConnection,
        secretColumn: 'webhook_url',
        plaintext: 'MMSECRET',
        create: (permCtx, name) =>
          notifications.createMattermost(permCtx, {
            ...flagsOff,
            name,
            ...mattermostConnection,
          }),
      },
      {
        type: 'custom',
        payload: customConnection,
        secretColumn: 'endpoint',
        plaintext: 'CUSTOMSECRET',
        create: (permCtx, name) =>
          notifications.createCustom(permCtx, {
            ...flagsOff,
            name,
            ...customConnection,
          }),
      },
      {
        type: 'lark',
        payload: larkConnection,
        secretColumn: 'webhook_url',
        plaintext: 'LARKSECRET',
        create: (permCtx, name) =>
          notifications.createLark(permCtx, {
            ...flagsOff,
            name,
            ...larkConnection,
          }),
      },
      {
        type: 'pushover',
        payload: pushoverConnection,
        secretColumn: 'api_token',
        plaintext: 'PUSHOVERTOKEN',
        create: (permCtx, name) =>
          notifications.createPushover(permCtx, {
            ...flagsOff,
            name,
            ...pushoverConnection,
          }),
      },
      {
        type: 'teams',
        payload: teamsConnection,
        secretColumn: 'webhook_url',
        plaintext: 'TEAMSSECRET',
        create: (permCtx, name) =>
          notifications.createTeams(permCtx, {
            ...flagsOff,
            name,
            ...teamsConnection,
          }),
      },
    ];

    it.each(cases)(
      '$type stores a retrievable notification with its secret encrypted at rest',
      async ({ type, payload, secretColumn, plaintext, create }) => {
        const { organizationId, owner: ownerSession } =
          await setUpOwner(server);
        const ownerCtx = permissionCtx(ownerSession.id, organizationId);

        const created = await create(ownerCtx, `${type}-channel`);

        expect(created.notificationType).toBe(type);
        const connection = created[type] as Record<string, unknown> & {
          [key: string]: unknown;
        };
        // The API projection drops the credential; the stored
        // row still round-trips the whole connection for delivery.
        expect(JSON.stringify(connection)).not.toContain(plaintext);
        const stored = (await storedChannels(created.notificationId))[type];
        expect(stored as Record<string, unknown>).toMatchObject(payload);

        const idColumn = `${type}_id`;
        const raw = await ctx.db.$client.query<Record<string, string>>(
          `select ${secretColumn} from ${type === 'email' ? '"email"' : type} where ${idColumn} = $1`,
          [connection[`${type}Id`]],
        );
        expect(raw.rows[0][secretColumn]).not.toContain(plaintext);
        expect(raw.rows[0][secretColumn].startsWith('enc:v1:')).toBe(true);
      },
    );

    it('pushover requires retry and expire for emergency priority', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      void ownerCtx;

      const res = await request(server)
        .post('/notifications/pushover')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'urgent',
          userKey: 'u',
          apiToken: 't',
          priority: 2,
        });
      expect(res.status).toBe(400);
    });
  });

  // a custom webhook authenticates with a header —
  // `Authorization: Bearer …`, `X-API-Key: …` — so `headers` is the same class
  // of credential as the endpoint beside it. It was plaintext `jsonb` and left
  // out of the projection fix (that was a decrypt-on-read leak; nothing decrypted
  // here because nothing was encrypted). A free-form map has no fixed key to project away,
  // so the read path answers with the names and keeps the values on the server.
  describe('custom channel headers', () => {
    const customChannel = {
      ...flagsOff,
      name: 'ops-webhook',
      appDeploy: true,
      endpoint: 'https://internal.example.com/hook',
      headers: { Authorization: 'Bearer HEADERSECRET', 'X-Trace': 'on' },
    };

    /** The `headers` column exactly as Postgres holds it. */
    const rawHeaders = async (customId: string): Promise<string> => {
      const raw = await ctx.db.$client.query<{ headers: string }>(
        'select headers from custom where custom_id = $1',
        [customId],
      );
      return raw.rows[0].headers;
    };

    it('stores the header map encrypted and round-trips it for delivery', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createCustom(ownerCtx, customChannel);

      const stored = await storedChannels(created.notificationId);
      expect(stored.custom?.headers).toEqual({
        Authorization: 'Bearer HEADERSECRET',
        'X-Trace': 'on',
      });

      const raw = await rawHeaders(created.custom!.customId);
      expect(raw).not.toContain('HEADERSECRET');
      expect(raw).not.toContain('Authorization');
      expect(raw.startsWith('enc:v1:')).toBe(true);
    });

    it('reports the header names it holds, never their values', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const post = (body: object) =>
        request(server)
          .post('/notifications/custom')
          .set('Cookie', ownerSession.cookie)
          .send(body);

      const created = await post(customChannel);
      expect(created.status).toBe(201);
      const { notificationId } = created.body as { notificationId: string };

      const found = await request(server)
        .get(`/notifications/${notificationId}`)
        .set('Cookie', ownerSession.cookie);
      expect(found.status).toBe(200);

      for (const body of [created.body, found.body]) {
        expect(JSON.stringify(body)).not.toContain('HEADERSECRET');
        // The ntfy `hasAccessToken` precedent, one step further: the console
        // still shows *which* headers are configured, so an operator can
        // confirm they set the right one, and `headerNames.length` is the
        // count. No value crosses the wire.
        const { custom } = body as {
          custom: { headerNames: string[] };
        };
        expect(custom.headerNames).toEqual(['Authorization', 'X-Trace']);
        expect(custom).not.toHaveProperty('headers');
      }

      // A webhook needing no header is not the same as one whose headers are
      // hidden, so the empty case answers with an empty list, not null.
      const headerless = await post({
        ...flagsOff,
        name: 'open-webhook',
        endpoint: 'https://internal.example.com/open',
      });
      expect(headerless.status).toBe(201);
      expect(
        (headerless.body as { custom: { headerNames: string[] } }).custom
          .headerNames,
      ).toEqual([]);
    });

    it('hands the real header values to the webhook on delivery', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/custom')
        .set('Cookie', ownerSession.cookie)
        .send(customChannel);
      expect(created.status).toBe(201);
      const { notificationId } = created.body as { notificationId: string };

      const res = await request(server)
        .post(`/notifications/${notificationId}/test`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(204);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://internal.example.com/hook',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer HEADERSECRET',
            'X-Trace': 'on',
          },
        }),
      );
    });

    it('re-encrypts a rotated header map', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createCustom(ownerCtx, customChannel);
      const updated = await notifications.updateCustom(
        ownerCtx,
        created.notificationId,
        { headers: { Authorization: 'Bearer ROTATEDSECRET' } },
      );
      expect(updated.custom?.headerNames).toEqual(['Authorization']);

      const stored = await storedChannels(created.notificationId);
      expect(stored.custom?.headers).toEqual({
        Authorization: 'Bearer ROTATEDSECRET',
      });
      const raw = await rawHeaders(created.custom!.customId);
      expect(raw).not.toContain('ROTATEDSECRET');
      expect(raw.startsWith('enc:v1:')).toBe(true);
    });

    it('reads a row the migration left in plaintext, and re-encrypts it on the next write', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createCustom(ownerCtx, customChannel);
      const customId = created.custom!.customId;

      // What the migration leaves behind on an instance that already had
      // custom channels: the old `jsonb` map cast to text, with no `enc:v1:`
      // prefix. ADR 0006 passes an unprefixed value through on read rather
      // than failing, and re-encrypts it on the next write.
      await ctx.db.$client.query(
        'update custom set headers = $2 where custom_id = $1',
        [customId, '{"Authorization": "Bearer LEGACYSECRET"}'],
      );

      const found = await notifications.findOne(
        ownerCtx,
        created.notificationId,
      );
      expect(found.custom?.headerNames).toEqual(['Authorization']);
      const stored = await storedChannels(created.notificationId);
      expect(stored.custom?.headers).toEqual({
        Authorization: 'Bearer LEGACYSECRET',
      });

      await notifications.updateCustom(ownerCtx, created.notificationId, {
        headers: { Authorization: 'Bearer LEGACYSECRET', 'X-Trace': 'on' },
      });
      const raw = await rawHeaders(customId);
      expect(raw).not.toContain('LEGACYSECRET');
      expect(raw.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('update', () => {
    it('updates flags and connection fields; a rotated webhook is re-encrypted', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createSlack(ownerCtx, slackChannel);

      const updated = await notifications.updateSlack(
        ownerCtx,
        created.notificationId,
        {
          name: 'renamed-slack',
          appDeploy: false,
          databaseBackup: true,
          webhookUrl: 'https://hooks.slack.com/services/T000/B000/ROTATED',
        },
      );
      expect(updated).toMatchObject({
        notificationId: created.notificationId,
        name: 'renamed-slack',
        appDeploy: false,
        databaseBackup: true,
      });
      expect(updated.slack).toMatchObject({ channel: '#deploys' });

      const stored = await storedChannels(created.notificationId);
      expect(stored.slack?.webhookUrl).toBe(
        'https://hooks.slack.com/services/T000/B000/ROTATED',
      );

      const raw = await ctx.db.$client.query<{ webhook_url: string }>(
        'select webhook_url from slack where slack_id = $1',
        [created.slack!.slackId],
      );
      expect(raw.rows[0].webhook_url).not.toContain('ROTATED');
      expect(raw.rows[0].webhook_url.startsWith('enc:v1:')).toBe(true);
    });
  });

  describe('list', () => {
    it('lists the organization notifications newest first with their channels', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        name: 'older',
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await notifications.createDiscord(ownerCtx, {
        ...flagsOff,
        name: 'newer',
        webhookUrl: 'https://discord.com/api/webhooks/1/X',
      });

      const listed = await notifications.list(ownerCtx);
      expect(listed.map((n) => n.name)).toEqual(['newer', 'older']);
      expect(listed[0].discord).not.toBeNull();
      expect(listed[1].slack).not.toBeNull();
    });
  });

  // every channel connection column is an `encryptedText`, which
  // decrypts on the way *out* of the driver — so a read that hydrates the
  // channel relations without a projection hands the caller the live
  // credential. The registry/destination/AI modules each strip theirs; these
  // pin that the notification read path does too.
  describe('credentials never leave the server', () => {
    // [channel segment, create payload, the plaintext secrets it carries,
    //  the non-secret connection fields that must survive the projection]
    const cases = [
      [
        'slack',
        {
          webhookUrl: 'https://hooks.slack.com/services/T/B/SLACKSECRET',
          channel: '#deploys',
        },
        ['SLACKSECRET'],
        { channel: '#deploys' },
      ],
      [
        'telegram',
        {
          botToken: '123456:ABC-BOTSECRET',
          chatId: '-1001234567890',
          messageThreadId: '42',
        },
        ['BOTSECRET'],
        { chatId: '-1001234567890', messageThreadId: '42' },
      ],
      [
        'discord',
        {
          webhookUrl: 'https://discord.com/api/webhooks/1/DISCORDSECRET',
          decoration: true,
        },
        ['DISCORDSECRET'],
        { decoration: true },
      ],
      [
        'email',
        {
          smtpServer: 'smtp.example.com',
          smtpPort: 587,
          username: 'mailer',
          password: 'SMTPPASSWORD',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        ['SMTPPASSWORD'],
        { smtpServer: 'smtp.example.com', smtpPort: 587, username: 'mailer' },
      ],
      [
        'resend',
        {
          apiKey: 're_RESENDSECRET',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        ['RESENDSECRET'],
        { fromAddress: 'noreply@example.com' },
      ],
      [
        'gotify',
        {
          serverUrl: 'https://gotify.example.com',
          appToken: 'GOTIFYTOKEN',
          priority: 5,
        },
        ['GOTIFYTOKEN'],
        { serverUrl: 'https://gotify.example.com', priority: 5 },
      ],
      [
        'ntfy',
        {
          serverUrl: 'https://ntfy.sh',
          topic: 'cloudgate-alerts',
          accessToken: 'NTFYTOKEN',
          priority: 3,
        },
        ['NTFYTOKEN'],
        { topic: 'cloudgate-alerts', priority: 3 },
      ],
      [
        'mattermost',
        {
          webhookUrl: 'https://mm.example.com/hooks/MMSECRET',
          channel: 'town-square',
          username: 'cloudgate',
        },
        ['MMSECRET'],
        { channel: 'town-square', username: 'cloudgate' },
      ],
      [
        'custom',
        {
          endpoint: 'https://internal.example.com/hook?key=CUSTOMSECRET',
          headers: { 'X-Api-Key': 'HEADERCREDENTIAL' },
        },
        ['CUSTOMSECRET', 'HEADERCREDENTIAL'],
        { headerNames: ['X-Api-Key'] },
      ],
      [
        'lark',
        { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/LARKSECRET' },
        ['LARKSECRET'],
        {},
      ],
      [
        'pushover',
        { userKey: 'PUSHOVERUSER', apiToken: 'PUSHOVERTOKEN', priority: 1 },
        ['PUSHOVERUSER', 'PUSHOVERTOKEN'],
        { priority: 1 },
      ],
      [
        'teams',
        { webhookUrl: 'https://outlook.office.com/webhook/TEAMSSECRET' },
        ['TEAMSSECRET'],
        {},
      ],
    ] as const;

    it.each(cases)(
      'a %s channel keeps its credential off create, list and read',
      async (type, payload, secrets, kept) => {
        const { owner: ownerSession } = await setUpOwner(server);

        const created = await request(server)
          .post(`/notifications/${type}`)
          .set('Cookie', ownerSession.cookie)
          .send({ ...flagsOff, name: `${type}-channel`, ...payload });
        expect(created.status).toBe(201);
        const { notificationId } = created.body as { notificationId: string };

        const listed = await request(server)
          .get('/notifications')
          .set('Cookie', ownerSession.cookie);
        expect(listed.status).toBe(200);
        const found = await request(server)
          .get(`/notifications/${notificationId}`)
          .set('Cookie', ownerSession.cookie);
        expect(found.status).toBe(200);

        for (const secret of secrets) {
          expect(JSON.stringify(created.body)).not.toContain(secret);
          expect(JSON.stringify(listed.body)).not.toContain(secret);
          expect(JSON.stringify(found.body)).not.toContain(secret);
        }

        // The projection drops the credential, not the connection: the
        // client still gets the fields it renders and the row's own id.
        const connection = (
          found.body as Record<string, Record<string, unknown>>
        )[type];
        expect(connection).toMatchObject(kept);
        expect(connection[`${type}Id`]).toEqual(expect.any(String));
      },
    );

    it('an ntfy channel reports that a token is stored, not the token', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const post = (body: object) =>
        request(server)
          .post('/notifications/ntfy')
          .set('Cookie', ownerSession.cookie)
          .send({ ...flagsOff, serverUrl: 'https://ntfy.sh', ...body });

      // ntfy's access token is optional, so "absent from the response" is
      // ambiguous: a public topic has no token, a private one has one the
      // client must not see. The projection answers with a boolean.
      const withToken = await post({
        name: 'private-topic',
        topic: 'private',
        accessToken: 'NTFYTOKEN',
      });
      expect(withToken.status).toBe(201);
      const withoutToken = await post({
        name: 'public-topic',
        topic: 'public',
      });
      expect(withoutToken.status).toBe(201);

      const listed = await request(server)
        .get('/notifications')
        .set('Cookie', ownerSession.cookie);
      expect(JSON.stringify(listed.body)).not.toContain('NTFYTOKEN');
      const rows = listed.body as {
        name: string;
        ntfy: { hasAccessToken: boolean };
      }[];
      const ntfyNamed = (name: string) =>
        rows.find((row) => row.name === name)!.ntfy;
      expect(ntfyNamed('private-topic').hasAccessToken).toBe(true);
      expect(ntfyNamed('public-topic').hasAccessToken).toBe(false);
    });

    it('the create and update responses do not echo the webhook url back', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/slack')
        .set('Cookie', ownerSession.cookie)
        .send(slackChannel);
      expect(created.status).toBe(201);
      expect(JSON.stringify(created.body)).not.toContain('SECRETTOKEN');

      const { notificationId } = created.body as { notificationId: string };
      const updated = await request(server)
        .patch(`/notifications/slack/${notificationId}`)
        .set('Cookie', ownerSession.cookie)
        .send({
          webhookUrl: 'https://hooks.slack.com/services/T000/B000/ROTATED',
        });
      expect(updated.status).toBe(200);
      expect(JSON.stringify(updated.body)).not.toContain('ROTATED');
    });
  });

  describe('remove', () => {
    it('deletes the notification and its channel connection row', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await notifications.createSlack(ownerCtx, slackChannel);

      const removed = await notifications.remove(
        ownerCtx,
        created.notificationId,
      );
      expect(removed.notificationId).toBe(created.notificationId);

      await expect(
        notifications.findOne(ownerCtx, created.notificationId),
      ).rejects.toThrow('Notification not found');

      // Removing a notification deletes its connection row too (the FK
      // cascades connection → notification).
      const raw = await ctx.db.$client.query(
        'select 1 from slack where slack_id = $1',
        [created.slack!.slackId],
      );
      expect(raw.rowCount).toBe(0);
    });
  });

  describe('dispatch fan-out', () => {
    const buildSuccess = {
      type: 'app-deploy',
      projectName: 'shop',
      applicationName: 'storefront',
      applicationType: 'application',
      environmentName: 'production',
      buildLink: 'https://cloudgate.example.com/deployments/42',
      domains: [],
    } as const;

    it('delivers only to the organization channels whose flag matches the event type', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      // Enabled for app-deploy in the caller's org: must fire.
      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        appDeploy: true,
      });
      // Same org, flag off: must not fire.
      await notifications.createDiscord(ownerCtx, {
        ...flagsOff,
        name: 'muted-discord',
        webhookUrl: 'https://discord.com/api/webhooks/1/MUTED',
      });
      // Other org, flag on: must not fire.
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
      await notifications.createTeams(secondOrgCtx, {
        ...flagsOff,
        name: 'other-org-teams',
        appDeploy: true,
        webhookUrl: 'https://outlook.office.com/webhook/OTHERORG',
      });

      const dispatcher = ctx.app.get(NotificationDispatcherService);
      await dispatcher.dispatch(organizationId, buildSuccess);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'https://hooks.slack.com/services/T000/B000/SECRETTOKEN',
      );
      const body = JSON.parse(init.body as string) as {
        channel: string;
        attachments: { pretext: string }[];
      };
      expect(body.channel).toBe('#deploys');
      expect(body.attachments[0].pretext).toBe(
        ':white_check_mark: *Build Success*',
      );
      expect(smtpMock.send).not.toHaveBeenCalled();
      expect(resendMock.send).not.toHaveBeenCalled();
    });

    it('delivers nothing when no channel has the event flag enabled', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      // appDeploy on, but the dispatched event is a database backup.
      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        appDeploy: true,
      });

      const dispatcher = ctx.app.get(NotificationDispatcherService);
      await dispatcher.dispatch(organizationId, {
        type: 'database-backup',
        projectName: 'shop',
        applicationName: 'orders-db',
        databaseType: 'postgres',
        status: 'success',
        databaseName: 'orders',
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('email channels deliver through the SMTP sender with the decrypted connection', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await notifications.createEmail(ownerCtx, {
        ...flagsOff,
        name: 'ops-mail',
        appDeploy: true,
        smtpServer: 'smtp.example.com',
        smtpPort: 587,
        username: 'mailer',
        password: 'SMTPPASSWORD',
        fromAddress: 'noreply@example.com',
        toAddresses: ['ops@example.com'],
      });

      const dispatcher = ctx.app.get(NotificationDispatcherService);
      await dispatcher.dispatch(organizationId, buildSuccess);

      expect(smtpMock.send).toHaveBeenCalledTimes(1);
      const [connection, subject] = smtpMock.send.mock.calls[0] as [
        { password: string },
        string,
      ];
      expect(connection).toMatchObject({
        smtpServer: 'smtp.example.com',
        password: 'SMTPPASSWORD',
        toAddresses: ['ops@example.com'],
      });
      expect(subject).toBe('Build success for Cloudgate');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a failing channel does not stop delivery to the others', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        name: 'first-slack',
        appDeploy: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await notifications.createLark(ownerCtx, {
        ...flagsOff,
        name: 'second-lark',
        appDeploy: true,
        webhookUrl: 'https://open.larksuite.com/bot/v2/hook/L',
      });

      fetchMock.mockRejectedValueOnce(new Error('slack is down'));

      const dispatcher = ctx.app.get(NotificationDispatcherService);
      await expect(
        dispatcher.dispatch(organizationId, buildSuccess),
      ).resolves.toBeUndefined();

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('test-connection endpoints', () => {
    it('POST /notifications/slack/test sends the hello probe to the webhook', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const res = await request(server)
        .post('/notifications/slack/test')
        .set('Cookie', ownerSession.cookie)
        .send({
          webhookUrl: 'https://hooks.slack.com/services/T/B/PROBE',
          channel: '#ops',
        });
      expect(res.status).toBe(204);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.slack.com/services/T/B/PROBE',
        expect.objectContaining({ method: 'POST' }),
      );
      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toEqual({
        channel: '#ops',
        text: TEST_MESSAGE,
      });
    });

    it('maps a failed probe to a 400 with the delivery error message', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      fetchMock.mockResolvedValue({ ok: false, statusText: 'Forbidden' });

      const res = await request(server)
        .post('/notifications/slack/test')
        .set('Cookie', ownerSession.cookie)
        .send({ webhookUrl: 'https://hooks.slack.com/x', channel: '#ops' });
      expect(res.status).toBe(400);
    });

    /**
     * The user-visible half. `LarkChannelStrategy.send` swallowed the
     * delivery and — the sharper part of the mechanism — never read
     * `response.ok`, so a webhook that refused the card resolved like a
     * delivery. `deliverTest` had nothing to map, and this route answered
     * **204 for a lark webhook that cannot deliver**: a plain wrong answer to
     * the one direct question an operator asks of a channel.
     *
     * Measured before the fix: this request answered 204, and so did the
     * `mockRejectedValue` case below. Lark was the last of the twelve to do
     * that; every other channel already answered 400 here.
     */
    it('POST /notifications/lark/test refuses a webhook that cannot deliver', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      fetchMock.mockResolvedValue({ ok: false, statusText: 'Bad Request' });

      const res = await request(server)
        .post('/notifications/lark/test')
        .set('Cookie', ownerSession.cookie)
        .send({ webhookUrl: 'https://open.larksuite.com/bot/v2/hook/PROBE' });
      expect(res.status).toBe(400);

      // The diagnosis is the whole reason the refusal is shown. This route is
      // the credential-taking one, so nothing is masked — the caller sent the
      // webhook and the console redacts its own copy (the established precedent).
      const { message } = res.body as { message: string };
      expect(message).toBe('Failed to send Lark notification: Bad Request');
    });

    it('POST /notifications/lark/test refuses an unreachable webhook', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      fetchMock.mockRejectedValue(
        new Error(
          'request to https://open.larksuite.com/bot/v2/hook/PROBE failed, ' +
            'reason: getaddrinfo ENOTFOUND open.larksuite.com',
        ),
      );

      const res = await request(server)
        .post('/notifications/lark/test')
        .set('Cookie', ownerSession.cookie)
        .send({ webhookUrl: 'https://open.larksuite.com/bot/v2/hook/PROBE' });
      expect(res.status).toBe(400);

      const { message } = res.body as { message: string };
      expect(message).toContain('getaddrinfo ENOTFOUND open.larksuite.com');
    });

    it('POST /notifications/email/test sends the test email through SMTP', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const res = await request(server)
        .post('/notifications/email/test')
        .set('Cookie', ownerSession.cookie)
        .send({
          smtpServer: 'smtp.example.com',
          smtpPort: 587,
          username: 'mailer',
          password: 'secret',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        });
      expect(res.status).toBe(204);

      expect(smtpMock.send).toHaveBeenCalledWith(
        expect.objectContaining({ smtpServer: 'smtp.example.com' }),
        TEST_TITLE,
        `<p>${TEST_MESSAGE}</p>`,
        // The probe has no header, so no logo to attach.
        undefined,
      );
    });
  });

  // the credential-taking routes above are right for a create — you
  // prove a webhook before you save it — but they are the *only* way to test,
  // and the console does not hold a saved channel's credential (the projection strips it).
  // So "is the alerting I set up three months ago still working?" could not be
  // asked at all. These pin the id-taking variant: the server loads the row the
  // dispatcher would load and pushes the same hello probe through it.
  describe('POST /notifications/:id/test — testing a channel already saved', () => {
    /** Everything any transport was handed, as one string. */
    const delivered = () =>
      JSON.stringify([
        fetchMock.mock.calls,
        smtpMock.send.mock.calls,
        resendMock.send.mock.calls,
      ]);

    it('pushes the hello probe through the stored, decrypted connection', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/slack')
        .set('Cookie', ownerSession.cookie)
        .send(slackChannel);
      expect(created.status).toBe(201);
      const { notificationId } = created.body as { notificationId: string };

      const res = await request(server)
        .post(`/notifications/${notificationId}/test`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(204);

      // The same probe `POST /notifications/slack/test` sends, against the
      // webhook the browser never saw — read back off the row and decrypted.
      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.slack.com/services/T000/B000/SECRETTOKEN',
        expect.objectContaining({ method: 'POST' }),
      );
      const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
      expect(JSON.parse(init.body)).toEqual({
        channel: '#deploys',
        text: TEST_MESSAGE,
      });
    });

    // [channel segment, create payload, the stored secret the transport must
    //  have been handed]. Pushover is the one channel whose credentials go out
    //  in a FormData body, which does not serialise — it has its own test.
    const cases = [
      [
        'slack',
        {
          webhookUrl: 'https://hooks.slack.com/services/T/B/SAVEDSLACK',
          channel: '#deploys',
        },
        'SAVEDSLACK',
      ],
      [
        'telegram',
        { botToken: '123456:ABC-SAVEDBOT', chatId: '-1001234567890' },
        'SAVEDBOT',
      ],
      [
        'discord',
        { webhookUrl: 'https://discord.com/api/webhooks/1/SAVEDDISCORD' },
        'SAVEDDISCORD',
      ],
      [
        'email',
        {
          smtpServer: 'smtp.example.com',
          smtpPort: 587,
          username: 'mailer',
          password: 'SAVEDSMTPPASSWORD',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        'SAVEDSMTPPASSWORD',
      ],
      [
        'resend',
        {
          apiKey: 're_SAVEDRESEND',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        'SAVEDRESEND',
      ],
      [
        'gotify',
        {
          serverUrl: 'https://gotify.example.com',
          appToken: 'SAVEDGOTIFY',
          priority: 5,
        },
        'SAVEDGOTIFY',
      ],
      [
        'ntfy',
        {
          serverUrl: 'https://ntfy.sh',
          topic: 'cloudgate-alerts',
          accessToken: 'SAVEDNTFY',
          priority: 3,
        },
        'SAVEDNTFY',
      ],
      [
        'mattermost',
        { webhookUrl: 'https://mm.example.com/hooks/SAVEDMM' },
        'SAVEDMM',
      ],
      [
        'custom',
        { endpoint: 'https://internal.example.com/hook?key=SAVEDCUSTOM' },
        'SAVEDCUSTOM',
      ],
      [
        'lark',
        { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/SAVEDLARK' },
        'SAVEDLARK',
      ],
      [
        'teams',
        { webhookUrl: 'https://outlook.office.com/webhook/SAVEDTEAMS' },
        'SAVEDTEAMS',
      ],
    ] as const;

    it.each(cases)(
      'a saved %s channel is tested with the credential it holds',
      async (type, payload, secret) => {
        const { owner: ownerSession } = await setUpOwner(server);

        const created = await request(server)
          .post(`/notifications/${type}`)
          .set('Cookie', ownerSession.cookie)
          .send({ ...flagsOff, name: `${type}-channel`, ...payload });
        expect(created.status).toBe(201);
        const { notificationId } = created.body as { notificationId: string };

        const res = await request(server)
          .post(`/notifications/${notificationId}/test`)
          .set('Cookie', ownerSession.cookie);
        expect(res.status).toBe(204);

        expect(delivered()).toContain(secret);
        // …and it stays on the server side of the call: the route answers
        // nothing, so there is no shape for the credential to come back in.
        expect(res.text).toBe('');
      },
    );

    it('a saved pushover channel is tested with the keys it holds', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/pushover')
        .set('Cookie', ownerSession.cookie)
        .send({
          ...flagsOff,
          name: 'pushover-channel',
          userKey: 'SAVEDPUSHOVERUSER',
          apiToken: 'SAVEDPUSHOVERTOKEN',
          priority: 1,
        });
      expect(created.status).toBe(201);
      const { notificationId } = created.body as { notificationId: string };

      const res = await request(server)
        .post(`/notifications/${notificationId}/test`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(204);

      // Pushover's credentials ride in a FormData body, so they are read off
      // the form rather than out of a JSON string.
      const [, init] = fetchMock.mock.calls[0] as [string, { body: FormData }];
      expect(init.body.get('user')).toBe('SAVEDPUSHOVERUSER');
      expect(init.body.get('token')).toBe('SAVEDPUSHOVERTOKEN');
    });

    it('a refusal diagnoses the failure without printing the stored credential', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/slack')
        .set('Cookie', ownerSession.cookie)
        .send(slackChannel);
      const { notificationId } = created.body as { notificationId: string };

      // What a transport really throws: the URL it could not reach, which for
      // a webhook *is* the credential (the same argument, one module over).
      fetchMock.mockRejectedValue(
        new Error(
          'request to https://hooks.slack.com/services/T000/B000/SECRETTOKEN ' +
            'failed, reason: getaddrinfo ENOTFOUND hooks.slack.com',
        ),
      );

      const res = await request(server)
        .post(`/notifications/${notificationId}/test`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(400);

      const { message } = res.body as { message: string };
      expect(message).not.toContain('SECRETTOKEN');
      // The diagnosis is the whole reason the refusal is shown; redaction
      // must not eat it.
      expect(message).toContain('getaddrinfo ENOTFOUND hooks.slack.com');
    });

    /**
     * The same shape at lark, which could not reach it until the fix: `send`
     * swallowed the failure and never read `response.ok`, so this route
     * answered 204 for a saved lark channel that cannot deliver — the one
     * question the route was added to ask. Measured before the fix: 204, with
     * `res.text` empty.
     *
     * Worth its own case rather than folding into the `it.each` above, because
     * lark is the channel whose credential *is* the whole URL and this is the
     * first refusal path where `redactCredentials` has a lark message to mask.
     */
    it('a saved lark channel that cannot deliver refuses without printing its webhook', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const created = await request(server)
        .post('/notifications/lark')
        .set('Cookie', ownerSession.cookie)
        .send({
          ...flagsOff,
          name: 'lark-channel',
          webhookUrl: 'https://open.larksuite.com/bot/v2/hook/SAVEDLARK',
        });
      expect(created.status).toBe(201);
      const { notificationId } = created.body as { notificationId: string };

      fetchMock.mockRejectedValue(
        new Error(
          'request to https://open.larksuite.com/bot/v2/hook/SAVEDLARK ' +
            'failed, reason: getaddrinfo ENOTFOUND open.larksuite.com',
        ),
      );

      const res = await request(server)
        .post(`/notifications/${notificationId}/test`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(400);

      const { message } = res.body as { message: string };
      expect(message).not.toContain('SAVEDLARK');
      expect(message).toContain('getaddrinfo ENOTFOUND open.larksuite.com');
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
      const foreign = await notifications.createSlack(
        secondOrgCtx,
        slackChannel,
      );

      // The session's active organization is the first one; the row belongs to
      // the second, so the lookup does not find it and nothing is sent.
      const res = await request(server)
        .post(`/notifications/${foreign.notificationId}/test`)
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        notifications.sendSavedTest(firstOrgCtx, foreign.notificationId),
      ).rejects.toThrow('Notification not found');
    });

    it('an unknown id reads as absent', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const res = await request(server)
        .post('/notifications/no-such-channel/test')
        .set('Cookie', ownerSession.cookie);
      expect(res.status).toBe(404);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the credential-taking route is untouched — a channel is still provable before it is saved', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const res = await request(server)
        .post('/notifications/slack/test')
        .set('Cookie', ownerSession.cookie)
        .send({
          webhookUrl: 'https://hooks.slack.com/services/T/B/UNSAVED',
          channel: '#ops',
        });
      expect(res.status).toBe(204);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://hooks.slack.com/services/T/B/UNSAVED',
        expect.objectContaining({ method: 'POST' }),
      );
      // `slack/test` still wins over `:id/test`, so nothing was looked up and
      // nothing was saved — the create case does not need a row to exist.
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      expect(await notifications.list(ownerCtx)).toEqual([]);
    });
  });

  describe('DeploymentNotifier adapter (Phase 21 port)', () => {
    it('buildSuccess and buildError fan out app-deploy / app-build-error to the org channels', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        appDeploy: true,
        appBuildError: true,
      });

      const notifier = ctx.app.get<DeploymentNotifier>(DEPLOYMENT_NOTIFIER);

      await notifier.buildSuccess({
        projectName: 'shop',
        applicationName: 'storefront',
        applicationType: 'application',
        environmentName: 'production',
        organizationId,
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceId: 'app-1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(slackAttachment().pretext).toBe(
        ':white_check_mark: *Build Success*',
      );

      fetchMock.mockClear();
      await notifier.buildError({
        projectName: 'shop',
        applicationName: 'storefront',
        applicationType: 'application',
        environmentName: 'production',
        organizationId,
        projectId: 'proj-1',
        environmentId: 'env-1',
        serviceId: 'app-1',
        errorMessage: 'npm exited 1',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(slackAttachment().pretext).toBe(':warning: *Build Failed*');
    });
  });

  describe('backup runs notify', () => {
    async function setUpBackup() {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const project = await ctx.app
        .get(ProjectsService)
        .create(ownerCtx, { name: 'cloudgate' });
      const environment = await ctx.app
        .get(EnvironmentsService)
        .create(ownerCtx, {
          name: 'production',
          projectId: project.projectId,
        });
      const database = await ctx.app.get(PostgresService).create(ownerCtx, {
        name: 'Main DB',
        appName: 'main-db',
        databaseName: 'shop',
        databaseUser: 'shop_user',
        databasePassword: 'sup3rS3cret',
        environmentId: environment.environmentId,
      });
      const destination = await ctx.app
        .get(DestinationsService)
        .create(ownerCtx, {
          name: 'prod-backups',
          provider: 'Cloudflare',
          accessKey: 'AKIAEXAMPLEACCESSKEY',
          secretAccessKey: 'wJalrXUtnFEMI-example-secret-key',
          bucket: 'cloudgate-backups',
          region: 'auto',
          endpoint: 'https://accountid.r2.cloudflarestorage.com',
        });
      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        appDeploy: false,
        databaseBackup: true,
        volumeBackup: true,
      });
      return { organizationId, ownerCtx, database, destination };
    }

    it('a manual database backup run dispatches a database-backup success event', async () => {
      const { ownerCtx, database, destination } = await setUpBackup();
      const backups = ctx.app.get(BackupsService);
      const backup = await backups.create(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        destinationId: destination.destinationId,
        databaseType: 'postgres',
        backupType: 'database',
        serviceId: database.postgresId,
      });

      await backups.runManual(ownerCtx, backup.backupId);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const attachment = slackAttachment();
      expect(attachment.pretext).toBe(
        ':white_check_mark: *Database Backup Successful*',
      );
      expect(attachment.fields).toEqual(
        expect.arrayContaining([
          { title: 'Project', value: 'cloudgate', short: true },
          { title: 'Application', value: 'Main DB', short: true },
          { title: 'Type', value: 'postgres', short: true },
          { title: 'Database Name', value: 'shop' },
        ]),
      );
    });

    it('a failed backup run dispatches an error event and still rethrows', async () => {
      const { ownerCtx, database, destination } = await setUpBackup();
      const backups = ctx.app.get(BackupsService);
      const backup = await backups.create(ownerCtx, {
        schedule: '0 3 * * *',
        prefix: 'daily',
        database: 'shop',
        destinationId: destination.destinationId,
        databaseType: 'postgres',
        backupType: 'database',
        serviceId: database.postgresId,
      });

      // Only the dump pipeline fails; the run recorder's log-file init and
      // other shell calls succeed. The script's stderr carries the step and the
      // engine's words, which is what a pressed Run now is answered with.
      execMock.execAsync.mockImplementation((command: string) =>
        command.includes('pg_dump')
          ? Promise.reject(
              new ExecError('pg_dump: connection refused', {
                command,
                stdout: '',
                stderr:
                  '❌ Error: Database dump failed\npg_dump: connection refused\n',
                exitCode: 1,
              }),
            )
          : Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      );

      await expect(
        backups.runManual(ownerCtx, backup.backupId),
      ).rejects.toThrow('The dump stopped with: pg_dump: connection refused');

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const attachment = slackAttachment();
      expect(attachment.pretext).toBe(':x: *Database Backup Failed*');
      expect(attachment.fields).toEqual(
        expect.arrayContaining([
          {
            title: 'Error Message',
            value: 'pg_dump: connection refused',
            short: false,
          },
        ]),
      );
    });

    it('a volume backup run dispatches a volume-backup success event', async () => {
      const { ownerCtx, database, destination } = await setUpBackup();
      const volumeBackups = ctx.app.get(VolumeBackupsService);
      const volumeBackup = await volumeBackups.create(ownerCtx, {
        name: 'data-volume',
        volumeName: 'main-db-data',
        prefix: 'volumes',
        schedule: '0 4 * * *',
        serviceType: 'postgres',
        serviceId: database.postgresId,
        turnOff: false,
        destinationId: destination.destinationId,
      });

      await volumeBackups.runManual(ownerCtx, volumeBackup.volumeBackupId);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const attachment = slackAttachment();
      expect(attachment.pretext).toBe(
        ':white_check_mark: *Volume Backup Successful*',
      );
      expect(attachment.fields).toEqual(
        expect.arrayContaining([
          { title: 'Volume Name', value: 'main-db-data', short: true },
          { title: 'Service Type', value: 'postgres', short: true },
        ]),
      );
    });
  });

  describe('server-threshold receive endpoint', () => {
    it('accepts a metrics alert by server token and fans out to the org channels', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        appDeploy: false,
        serverThreshold: true,
      });

      // A remote server whose metricsConfig carries the alert token. Written
      // through the ORM rather than the `jsonb_set` this used to be: the
      // column is `encryptedJson`, so `metrics_config` is `text`
      // holding `enc:v1:…` and there is no jsonb to set a path inside. Going
      // through the column is also the stronger setup — it stores the token
      // exactly as `setupMonitoring` would, ciphertext and all, so what this
      // test authenticates against is the encrypted value.
      const sshKey = await request(server)
        .post('/ssh-keys')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'worker-key' });
      expect(sshKey.status).toBe(201);
      const created = await request(server)
        .post('/servers')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'worker-1',
          ipAddress: '10.0.0.5',
          port: 22,
          username: 'root',
          sshKeyId: (sshKey.body as { sshKeyId: string }).sshKeyId,
        });
      expect(created.status).toBe(201);
      const serverId = (created.body as { serverId: string }).serverId;
      await ctx.db
        .update(serverTable)
        .set({
          metricsConfig: {
            ...defaultMetricsConfig,
            server: { ...defaultMetricsConfig.server, token: 'alert-token-1' },
          },
        })
        .where(eq(serverTable.serverId, serverId));

      // No session cookie: the metrics agent posts unauthenticated.
      const res = await request(server).post('/notifications/receive').send({
        ServerType: 'Remote',
        Type: 'CPU',
        Value: 92.5,
        Threshold: 80,
        Message: 'CPU usage high',
        Timestamp: '2026-07-24T09:00:00.000Z',
        Token: 'alert-token-1',
      });
      expect(res.status).toBe(204);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const attachment = slackAttachment();
      expect(attachment.pretext).toBe(':warning: *Server CPU Alert*');
      expect(attachment.fields).toEqual(
        expect.arrayContaining([
          { title: 'Server Name', value: 'Remote', short: true },
          { title: 'Current Value', value: '92.50%', short: true },
        ]),
      );
    });

    it('rejects an unknown token', async () => {
      const res = await request(server).post('/notifications/receive').send({
        ServerType: 'Remote',
        Type: 'Memory',
        Value: 91,
        Threshold: 85,
        Message: 'Memory usage high',
        Timestamp: '2026-07-24T09:00:00.000Z',
        Token: 'bogus',
      });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refuses the empty token a Server that was never set up carries', async () => {
      // Found while rewriting the lookup for the at-rest change.
      // `defaultMetricsConfig` sets `token: ''` and `Token` is a bare `z.string()`, so
      // `metrics_config -> 'server' ->> 'token' = ''` matched **every** Server
      // on the instance that had never had monitoring set up, took the first
      // one, and dispatched into its organization's channels — an
      // unauthenticated caller injecting arbitrary alert text (`Message`,
      // `Type`, `Value`) into someone else's Slack. The local branch beside it
      // has always guarded this (`if (!token || token !== input.Token)`); only
      // the SQL branch did not, because a `where` cannot express "and not
      // empty" without being told to.
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        appDeploy: false,
        serverThreshold: true,
      });

      const sshKey = await request(server)
        .post('/ssh-keys')
        .set('Cookie', ownerSession.cookie)
        .send({ name: 'never-set-up-key' });
      const created = await request(server)
        .post('/servers')
        .set('Cookie', ownerSession.cookie)
        .send({
          name: 'never-set-up',
          ipAddress: '10.0.0.9',
          port: 22,
          username: 'root',
          sshKeyId: (sshKey.body as { sshKeyId: string }).sshKeyId,
        });
      expect(created.status).toBe(201);

      const res = await request(server).post('/notifications/receive').send({
        ServerType: 'Remote',
        Type: 'CPU',
        Value: 99,
        Threshold: 80,
        Message: 'CPU usage high',
        Timestamp: '2026-07-24T09:00:00.000Z',
        Token: '',
      });
      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('accepts a local-instance alert by the web-server settings token', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      await notifications.createSlack(ownerCtx, {
        ...slackChannel,
        appDeploy: false,
        serverThreshold: true,
      });

      // Through the column, for the reason the remote case above gives.
      await ctx.db.insert(webServerSettings).values({
        metricsConfig: {
          ...defaultWebServerMetricsConfig,
          server: {
            ...defaultWebServerMetricsConfig.server,
            token: 'local-token-9',
          },
        },
      });

      const wrongToken = await request(server)
        .post('/notifications/receive')
        .send({
          ServerType: 'Cloudgate',
          Type: 'CPU',
          Value: 95,
          Threshold: 80,
          Message: 'CPU usage high',
          Timestamp: '2026-07-24T09:00:00.000Z',
          Token: 'bogus',
        });
      expect(wrongToken.status).toBe(400);

      const res = await request(server).post('/notifications/receive').send({
        ServerType: 'Cloudgate',
        Type: 'CPU',
        Value: 95,
        Threshold: 80,
        Message: 'CPU usage high',
        Timestamp: '2026-07-24T09:00:00.000Z',
        Token: 'local-token-9',
      });
      expect(res.status).toBe(204);

      // The local instance has no organization row — the alert fans out
      // instance-wide, named after the platform.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const attachment = slackAttachment();
      expect(attachment.fields).toEqual(
        expect.arrayContaining([
          { title: 'Server Name', value: 'Cloudgate', short: true },
        ]),
      );
    });
  });

  describe('cross-org isolation', () => {
    it('a notification is invisible and immutable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await notifications.createSlack(
        secondOrgCtx,
        slackChannel,
      );

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        notifications.findOne(firstOrgCtx, foreign.notificationId),
      ).rejects.toThrow('Notification not found');
      await expect(
        notifications.updateSlack(firstOrgCtx, foreign.notificationId, {
          name: 'stolen',
        }),
      ).rejects.toThrow('Notification not found');
      await expect(
        notifications.remove(firstOrgCtx, foreign.notificationId),
      ).rejects.toThrow('Notification not found');
      expect(await notifications.list(firstOrgCtx)).toEqual([]);
    });
  });
});
