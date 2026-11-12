import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { notificationType } from '../../src/db/schema';
import type { NotificationType } from '../../src/db/schema';
import { deliveryFailureMessage } from '../../src/notifications/channels/channel-failure';
import {
  TEST_MESSAGE,
  TEST_TITLE,
} from '../../src/notifications/channels/channel.strategy';
import { CustomChannelStrategy } from '../../src/notifications/channels/custom.strategy';
import { DiscordChannelStrategy } from '../../src/notifications/channels/discord.strategy';
import { EmailChannelStrategy } from '../../src/notifications/channels/email.strategy';
import { GotifyChannelStrategy } from '../../src/notifications/channels/gotify.strategy';
import { LarkChannelStrategy } from '../../src/notifications/channels/lark.strategy';
import { MattermostChannelStrategy } from '../../src/notifications/channels/mattermost.strategy';
import { NtfyChannelStrategy } from '../../src/notifications/channels/ntfy.strategy';
import { PushoverChannelStrategy } from '../../src/notifications/channels/pushover.strategy';
import { ResendChannelStrategy } from '../../src/notifications/channels/resend.strategy';
import { SlackChannelStrategy } from '../../src/notifications/channels/slack.strategy';
import { TeamsChannelStrategy } from '../../src/notifications/channels/teams.strategy';
import { TelegramChannelStrategy } from '../../src/notifications/channels/telegram.strategy';
import type { ChannelEvent } from '../../src/notifications/channels/channel.strategy';
import { EXPIRING_GUIDANCE } from '../../src/enterprise/license/license-expiring.service';
import { STOPPED_BY_LAPSE } from '../../src/enterprise/license/paid-features';
import { EVENT_FLAG_COLUMNS } from '../../src/notifications/events/notification-event';
import type {
  AgentRateLimitedEvent,
  AiModelNotAnsweringEvent,
  AppBuildErrorEvent,
  AppDeployEvent,
  DatabaseBackupEvent,
  DockerCleanupEvent,
  InstanceBackupEvent,
  InstanceRestartEvent,
  LicenseExpiringEvent,
  LicenseLapseEvent,
  NotificationEvent,
  PreviewTeardownStuckEvent,
  ServerThresholdEvent,
  ServiceIncidentEvent,
  VolumeBackupEvent,
} from '../../src/notifications/events/notification-event';

// Each channel's HTTP API is a system boundary: the strategies get a mocked
// fetch client and the tests pin the exact payload each strategy sends for a
// build-success event.

const buildSuccess: AppDeployEvent = {
  type: 'app-deploy',
  projectName: 'shop',
  applicationName: 'storefront',
  applicationType: 'application',
  environmentName: 'production',
  buildLink: 'https://cloudgate.example.com/deployments/42',
  domains: [
    { host: 'shop.example.com', https: true },
    { host: 'staging.shop.example.com', https: false },
    { host: 'admin.shop.example.com', https: true },
  ],
};

const buildError: AppBuildErrorEvent = {
  type: 'app-build-error',
  projectName: 'shop',
  applicationName: 'storefront',
  applicationType: 'application',
  errorMessage: 'npm exited 1',
  buildLink: 'https://cloudgate.example.com/deployments/42',
};

const databaseBackupFailed: DatabaseBackupEvent = {
  type: 'database-backup',
  projectName: 'shop',
  applicationName: 'orders-db',
  databaseType: 'postgres',
  status: 'error',
  databaseName: 'orders',
  errorMessage: 'pg_dump: connection refused',
};

const volumeBackupSucceeded: VolumeBackupEvent = {
  type: 'volume-backup',
  projectName: 'shop',
  applicationName: 'storefront',
  volumeName: 'data',
  serviceType: 'application',
  status: 'success',
  backupSize: '42 MB',
};

const dockerCleanup: DockerCleanupEvent = {
  type: 'docker-cleanup',
  message: 'Removed 5 images',
};

const serverThreshold: ServerThresholdEvent = {
  type: 'server-threshold',
  serverName: 'Remote',
  metric: 'CPU',
  value: 92.5,
  threshold: 80,
  message: 'CPU usage high',
  timestamp: '2026-07-24T09:00:00.000Z',
};

const instanceBackup: InstanceBackupEvent = {
  type: 'instance-backup',
  status: 'success',
  backupSize: '120 MB',
};

const instanceRestart: InstanceRestartEvent = { type: 'instance-restart' };

// The only event here whose `message` is load-bearing rather than colour: it
// carries the reason nobody was migrated off their custom role, which is the
// first thing an operator proposes on reading the alert.
const licenseLapse: LicenseLapseEvent = {
  type: 'license-lapse',
  organizationId: 'org_1',
  organizationName: 'Acme',
  validUntil: '2026-08-01T00:00:00.000Z',
  stopped: STOPPED_BY_LAPSE,
  strandedMembers: [
    { name: 'Ida Rhodes', email: 'ida@example.com', role: 'read-only' },
    { name: 'Jean Bartik', email: 'jean@example.com', role: 'deployer' },
  ],
  message:
    '2 members hold a custom role, which cannot resolve without a valid ' +
    'license. Activate a license, or move them to the admin or member role. ' +
    'Nobody was moved automatically: the static member role grants backups, ' +
    'volumes and environment variables outright, so migrating a custom-role ' +
    'holder onto it would silently widen their access.',
};

// A lapse nobody holds a custom role through is reported too: what
// stopped, and no "Locked Out" part at all.
const licenseLapseStrandingNobody: LicenseLapseEvent = {
  ...licenseLapse,
  strandedMembers: [],
  message:
    'Nobody holds a custom role, so nobody is locked out. Everything that ' +
    'stopped is kept as it was and works again once a license is activated.',
};

// The same license 3 days before its validUntil.
const licenseExpiring: LicenseExpiringEvent = {
  type: 'license-expiring',
  organizationId: 'org_1',
  organizationName: 'Acme',
  validUntil: '2026-08-01T00:00:00.000Z',
  daysLeft: 3,
  message: EXPIRING_GUIDANCE,
};

/**
 * The substance every channel has to carry: the organization, each stranded
 * member identified three ways, and the reason nobody was migrated. Fragments
 * rather than a rendered line, because a machine-facing channel (the custom
 * webhook) is right to send structured members while prose channels render
 * them — the punctuation is the channel's business, the facts are not.
 */
const lapseSubstance = [
  'Acme',
  'Ida Rhodes',
  'ida@example.com',
  'read-only',
  'Jean Bartik',
  'jean@example.com',
  'deployer',
  'widen their access',
];

// The loop signal: the first 429 of an Agent's episode, on its read
// budget, through the key that starts `cg_loop`.
const agentRateLimited: AgentRateLimitedEvent = {
  type: 'agent-rate-limited',
  organizationId: 'org_1',
  organizationName: 'Acme',
  agentName: 'loop-bot',
  budget: { kind: 'read', perMinute: 120, burst: 60 },
  keyPrefix: 'cg_loop',
  agentLink: 'https://cloudgate.example.com/settings/agents#agent-a1',
  message: 'Suspend it to stop it now; its keys and access are kept.',
};

/**
 * What the rate-limited Notification has to carry on every channel: the Agent,
 * the Organization, the budget with its numbers, the key, the way to stop it,
 * and its row.
 */
const rateLimitedSubstance = [
  'loop-bot',
  'Acme',
  '120',
  '60',
  'cg_loop',
  'Suspend it to stop it now; its keys and access are kept.',
  'https://cloudgate.example.com/settings/agents#agent-a1',
];

// The expiry sweep is stuck: three requested previews on one dead
// Server, two of them one Application's.
const previewTeardownStuck: PreviewTeardownStuckEvent = {
  type: 'preview-teardown-stuck',
  organizationId: 'org_1',
  serverId: 'srv_1',
  serverName: 'edge-1',
  stuckCount: 3,
  applications: [
    { name: 'Web App', stuck: 2 },
    { name: 'Billing API', stuck: 1 },
  ],
  stuckSince: '2026-07-24T10:15:00.000Z',
  message:
    'Their slots stay taken until the copies are gone, so new requested previews on these Applications may be refused. Cloudgate keeps retrying the teardown every minute.',
};

/**
 * What the stuck-teardown Notification has to carry on every channel: the
 * Server, how many are stuck, the Applications holding the slots, and that
 * the slots stay taken until the copies are gone.
 */
const teardownStuckSubstance = [
  'edge-1',
  '3 requested previews',
  'Web App (2)',
  'Billing API',
  'slots stay taken until the copies are gone',
];

// An Uptime check's third down Probe opened an Incident on `web`, and
// the first up Probe closed it.
const serviceIncidentOpened: ServiceIncidentEvent = {
  type: 'service-incident',
  organizationId: 'org_1',
  state: 'opened',
  source: 'uptime-check',
  serviceName: 'web',
  projectName: 'Shop',
  environmentName: 'production',
  target: 'https://shop.example.com/health',
  openingError: 'status 503',
  openedAt: '2026-07-24T10:15:00.000Z',
  serviceLink: 'https://cloudgate.example.com/applications/app_1/health',
};

const serviceIncidentClosed: ServiceIncidentEvent = {
  ...serviceIncidentOpened,
  state: 'closed',
  closedAt: '2026-07-24T10:25:00.000Z',
  reason: 'service-stopped',
};

// Calls to the AI model `llm` stopped reaching its runtime on `gpu-1`.
const aiModelNotAnswering: AiModelNotAnsweringEvent = {
  type: 'ai-model-not-answering',
  organizationId: 'org_1',
  aiModelName: 'llm',
  projectName: 'Support',
  environmentName: 'production',
  model: 'llama3.1:8b',
  serverName: 'gpu-1',
  failedAt: '2026-07-24T10:15:00.000Z',
  aiModelLink: 'https://cloudgate.example.com/applications/app_1/model',
  message:
    'Calls through the gateway are failing while it should be running. Check its tasks and logs; you are told again only after a call gets through and a later one fails.',
};

/**
 * What the not-answering Notification has to carry on every channel: the AI
 * model, where it lives, what it serves and runs on, what to do, and its
 * Model tab.
 */
const notAnsweringSubstance = [
  'AI Model Not Answering',
  'llm',
  'Support',
  'production',
  'llama3.1:8b',
  'gpu-1',
  'Calls through the gateway are failing while it should be running.',
  'https://cloudgate.example.com/applications/app_1/model',
];

/**
 * What an Incident Notification has to carry on every channel: the Service,
 * where it lives, the target, the opening error and the console link.
 */
const incidentSubstance = [
  'web',
  'Shop',
  'production',
  'https://shop.example.com/health',
  'status 503',
  'https://cloudgate.example.com/applications/app_1/health',
];

// The strategies stamp the send time themselves; fake timers pin it so
// date-bearing fields are stable.
const pinnedNow = new Date('2026-07-24T10:30:00.000Z');
const unixDate = Math.trunc(Number(pinnedNow) / 1000);

const fetchMock = jest.fn();

const jsonBody = (call = 0): Record<string, unknown> => {
  const [, init] = fetchMock.mock.calls[call] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
};

beforeEach(() => {
  // Only Date is faked: the email strategies render through React's
  // streaming SSR, which needs real task scheduling.
  jest.useFakeTimers({
    now: pinnedNow,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('SlackChannelStrategy', () => {
  it('posts the build-success attachment to the webhook', async () => {
    const strategy = new SlackChannelStrategy(fetchMock as never);

    await strategy.send(
      { webhookUrl: 'https://hooks.slack.com/services/T/B/X', channel: '#ops' },
      buildSuccess,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://hooks.slack.com/services/T/B/X',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    expect(jsonBody()).toEqual({
      channel: '#ops',
      attachments: [
        {
          color: '#00FF00',
          pretext: ':white_check_mark: *Build Success*',
          fields: [
            { title: 'Project', value: 'shop', short: true },
            { title: 'Application', value: 'storefront', short: true },
            { title: 'Environment', value: 'production', short: true },
            { title: 'Type', value: 'application', short: true },
            {
              title: 'Time',
              value: '2026-07-24 10:30:00 UTC',
              short: true,
            },
            {
              title: 'Details',
              value:
                '<https://cloudgate.example.com/deployments/42|View Build Details>',
              short: false,
            },
          ],
          mrkdwn_in: ['fields'],
        },
      ],
    });
  });

  /**
   * The sentence used to be said twice — *"Failed to send slack notification
   * Failed to send slack notification Forbidden"* — because the `catch` wrapped
   * the non-ok `throw` its own `try` had just raised. Each strategy now composes it in one
   * place, which takes off a prefix already there, so the re-wrap is harmless
   * and the operator reads one sentence.
   */
  it('wraps a non-ok webhook response in the slack failure message once', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Forbidden' });
    const strategy = new SlackChannelStrategy(fetchMock as never);

    await expect(
      strategy.send({ webhookUrl: 'https://x', channel: null }, buildSuccess),
    ).rejects.toThrow('Failed to send Slack notification: Forbidden');
  });
});

describe('DiscordChannelStrategy', () => {
  it('posts the build-success embed with decorations enabled', async () => {
    const strategy = new DiscordChannelStrategy(fetchMock as never);

    await strategy.send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      buildSuccess,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/1/X',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(jsonBody()).toEqual({
      embeds: [
        {
          title: '> `✅` Build Successes',
          color: 0x57f287,
          fields: [
            { name: '`🛠️` Project', value: 'shop', inline: true },
            { name: '`⚙️` Application', value: 'storefront', inline: true },
            { name: '`🌍` Environment', value: 'production', inline: true },
            { name: '`❔` Type', value: 'application', inline: true },
            { name: '`📅` Date', value: `<t:${unixDate}:D>`, inline: true },
            { name: '`⌚` Time', value: `<t:${unixDate}:t>`, inline: true },
            { name: '`❓` Type', value: 'Successful', inline: true },
            {
              name: '`🧷` Build Link',
              value:
                '[Click here to access build link](https://cloudgate.example.com/deployments/42)',
            },
          ],
          timestamp: pinnedNow.toISOString(),
          footer: { text: 'Cloudgate Build Notification' },
        },
      ],
    });
  });

  it('omits the decorations when the connection disables them', async () => {
    const strategy = new DiscordChannelStrategy(fetchMock as never);

    await strategy.send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: null },
      buildSuccess,
    );

    const body = jsonBody() as {
      embeds: { title: string; fields: { name: string }[] }[];
    };
    expect(body.embeds[0].title).toBe('`✅` Build Successes');
    expect(body.embeds[0].fields[0].name).toBe('Project');
  });
});

describe('TelegramChannelStrategy', () => {
  it('sends the build-success HTML message with logs and domain buttons', async () => {
    const strategy = new TelegramChannelStrategy(fetchMock as never);

    await strategy.send(
      {
        botToken: '123:ABC',
        chatId: '-10042',
        messageThreadId: '7',
      },
      buildSuccess,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123:ABC/sendMessage',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(jsonBody()).toEqual({
      chat_id: '-10042',
      message_thread_id: '7',
      text:
        '<b>✅ Build Success</b>\n\n<b>Project:</b> shop\n<b>Application:</b> storefront\n' +
        '<b>Environment:</b> production\n<b>Type:</b> application\n<b>Time:</b> 2026-07-24 10:30:00 UTC',
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'Deployment Logs',
              url: 'https://cloudgate.example.com/deployments/42',
            },
          ],
          [
            { text: 'shop.example.com', url: 'https://shop.example.com' },
            {
              text: 'staging.shop.example.com',
              url: 'http://staging.shop.example.com',
            },
          ],
          [
            {
              text: 'admin.shop.example.com',
              url: 'https://admin.shop.example.com',
            },
          ],
        ],
      },
    });
  });

  // Until the fix this strategy logged a delivery failure and resolved, which
  // made telegram the one channel of the twelve whose refusals — and telegram
  // refuses rather than degrades — reported as deliveries.
  it('reports a delivery failure rather than logging it and resolving', async () => {
    fetchMock.mockRejectedValue(new Error('telegram down'));
    const strategy = new TelegramChannelStrategy(fetchMock as never);

    await expect(
      strategy.send(
        { botToken: 't', chatId: 'c', messageThreadId: null },
        buildSuccess,
      ),
    ).rejects.toThrow('telegram down');
  });
});

describe('MattermostChannelStrategy', () => {
  it('posts the build-success markdown with prefixed channel and username', async () => {
    const strategy = new MattermostChannelStrategy(fetchMock as never);

    await strategy.send(
      {
        webhookUrl: 'https://mm.example.com/hooks/X',
        channel: 'town-square',
        username: null,
      },
      buildSuccess,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://mm.example.com/hooks/X',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(jsonBody()).toEqual({
      text:
        '**✅ Build Success**\n\n**Project:** shop\n**Application:** storefront\n' +
        '**Type:** application\n**Time:** 2026-07-24 10:30:00 UTC\n\n[View Build Details](https://cloudgate.example.com/deployments/42)',
      channel: '#town-square',
      username: 'Cloudgate',
    });
  });
});

describe('TeamsChannelStrategy', () => {
  it('posts the build-success adaptive card', async () => {
    const strategy = new TeamsChannelStrategy(fetchMock as never);

    await strategy.send(
      { webhookUrl: 'https://outlook.office.com/webhook/X' },
      buildSuccess,
    );

    expect(jsonBody()).toEqual({
      type: 'message',
      attachments: [
        {
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            type: 'AdaptiveCard',
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            version: '1.4',
            body: [
              {
                type: 'TextBlock',
                text: '✅ Build Success',
                size: 'Medium',
                weight: 'Bolder',
                wrap: true,
              },
              {
                type: 'FactSet',
                facts: [
                  { title: 'Project', value: 'shop' },
                  { title: 'Application', value: 'storefront' },
                  { title: 'Environment', value: 'production' },
                  { title: 'Type', value: 'application' },
                  { title: 'Date', value: '2026-07-24 10:30:00 UTC' },
                ],
              },
            ],
            actions: [
              {
                type: 'Action.OpenUrl',
                title: 'View Build Details',
                url: 'https://cloudgate.example.com/deployments/42',
              },
            ],
          },
        },
      ],
    });
  });
});

describe('CustomChannelStrategy', () => {
  it('posts the build-success payload with merged headers', async () => {
    const strategy = new CustomChannelStrategy(fetchMock as never);

    await strategy.send(
      {
        endpoint: 'https://internal.example.com/hook',
        headers: { 'X-Api-Key': 'abc' },
      },
      buildSuccess,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://internal.example.com/hook',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'abc' },
      }),
    );
    expect(jsonBody()).toEqual({
      title: 'Build Success',
      message: 'Build completed successfully',
      projectName: 'shop',
      applicationName: 'storefront',
      applicationType: 'application',
      buildLink: 'https://cloudgate.example.com/deployments/42',
      timestamp: pinnedNow.toISOString(),
      date: '2026-07-24 10:30:00 UTC',
      domains:
        'shop.example.com, staging.shop.example.com, admin.shop.example.com',
      status: 'success',
      type: 'build',
    });
  });
});

describe('GotifyChannelStrategy', () => {
  it('posts the build-success title/message with the app token header', async () => {
    const strategy = new GotifyChannelStrategy(fetchMock as never);

    await strategy.send(
      {
        serverUrl: 'https://gotify.example.com',
        appToken: 'TOKEN',
        priority: 5,
        decoration: true,
      },
      buildSuccess,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://gotify.example.com/message',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gotify-Key': 'TOKEN',
        },
      }),
    );
    expect(jsonBody()).toEqual({
      title: '✅ Build Success\n',
      message:
        '🛠️ Project: shop\n' +
        '⚙️ Application: storefront\n' +
        '🌍 Environment: production\n' +
        '❔ Type: application\n' +
        `🕒 Date: 2026-07-24 10:30:00 UTC\n` +
        '🔗 Build details:\nhttps://cloudgate.example.com/deployments/42\n',
      priority: 5,
      extras: {
        'client::display': { contentType: 'text/plain' },
      },
    });
  });
});

describe('NtfyChannelStrategy', () => {
  it('posts the build-success message to the topic with header metadata', async () => {
    const strategy = new NtfyChannelStrategy(fetchMock as never);

    await strategy.send(
      {
        serverUrl: 'https://ntfy.sh',
        topic: 'cloudgate-alerts',
        accessToken: 'NTFYTOKEN',
        priority: 4,
      },
      buildSuccess,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://ntfy.sh/cloudgate-alerts',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer NTFYTOKEN',
          'X-Priority': '4',
          'X-Title': 'Build Success',
          'X-Tags': 'white_check_mark',
          'X-Actions':
            'view, Build details, https://cloudgate.example.com/deployments/42, clear=true;',
        },
        body:
          '🛠Project: shop\n' +
          '⚙️Application: storefront\n' +
          '🌍Environment: production\n' +
          '❔Type: application\n' +
          `🕒Date: 2026-07-24 10:30:00 UTC`,
      }),
    );
  });

  it('omits the Authorization header without an access token', async () => {
    const strategy = new NtfyChannelStrategy(fetchMock as never);

    await strategy.send(
      {
        serverUrl: 'https://ntfy.sh',
        topic: 'alerts',
        accessToken: null,
        priority: 3,
      },
      buildSuccess,
    );

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(init.headers).not.toHaveProperty('Authorization');
  });
});

describe('PushoverChannelStrategy', () => {
  it('form-posts the build-success title/message', async () => {
    const strategy = new PushoverChannelStrategy(fetchMock as never);

    await strategy.send(
      {
        userKey: 'USER',
        apiToken: 'TOKEN',
        priority: 1,
        retry: null,
        expire: null,
      },
      buildSuccess,
    );

    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { method: string; body: URLSearchParams },
    ];
    expect(url).toBe('https://api.pushover.net/1/messages.json');
    expect(init.method).toBe('POST');
    expect(Object.fromEntries(init.body)).toEqual({
      token: 'TOKEN',
      user: 'USER',
      title: 'Build Success',
      message:
        'Project: shop\nApplication: storefront\nEnvironment: production\n' +
        `Type: application\nDate: 2026-07-24 10:30:00 UTC`,
      priority: '1',
    });
  });

  it('appends retry/expire for emergency priority', async () => {
    const strategy = new PushoverChannelStrategy(fetchMock as never);

    await strategy.send(
      { userKey: 'U', apiToken: 'T', priority: 2, retry: 45, expire: 900 },
      buildSuccess,
    );

    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    expect(init.body.get('retry')).toBe('45');
    expect(init.body.get('expire')).toBe('900');
  });
});

describe('EmailChannelStrategy', () => {
  it('renders the build-success email and sends it through the SMTP sender', async () => {
    const smtp = { send: jest.fn().mockResolvedValue(undefined) };
    const strategy = new EmailChannelStrategy(smtp as never);

    const connection = {
      smtpServer: 'smtp.example.com',
      smtpPort: 587,
      username: 'mailer',
      password: 'secret',
      fromAddress: 'noreply@example.com',
      toAddresses: ['ops@example.com'],
    };
    await strategy.send(connection, buildSuccess);

    expect(smtp.send).toHaveBeenCalledTimes(1);
    const [conn, subject, html] = smtp.send.mock.calls[0] as [
      unknown,
      string,
      string,
    ];
    expect(conn).toBe(connection);
    expect(subject).toBe('Build success for Cloudgate');
    expect(html).toContain('<!DOCTYPE html');
    expect(html).toContain('shop');
    expect(html).toContain('storefront');
    expect(html).toContain('production');
  });

  it('attaches the header logo once, inline, for the cid: image the html references', async () => {
    const smtp = { send: jest.fn().mockResolvedValue(undefined) };

    await new EmailChannelStrategy(smtp as never).send(
      {
        smtpServer: 'smtp.example.com',
        smtpPort: 587,
        username: 'mailer',
        password: 'secret',
        fromAddress: 'noreply@example.com',
        toAddresses: ['ops@example.com'],
      },
      buildSuccess,
    );

    const [, , html, attachments] = smtp.send.mock.calls[0] as [
      unknown,
      string,
      string,
      { cid?: string; contentType?: string }[],
    ];
    expect(html).toContain('src="cid:cloudgate-logo"');
    expect(attachments).toEqual([
      expect.objectContaining({
        cid: 'cloudgate-logo',
        contentType: 'image/png',
      }),
    ]);
  });
});

describe('ResendChannelStrategy', () => {
  it('renders the build-success email and sends it through the Resend sender', async () => {
    const resend = { send: jest.fn().mockResolvedValue(undefined) };
    const strategy = new ResendChannelStrategy(resend as never);

    const connection = {
      apiKey: 're_x',
      fromAddress: 'noreply@example.com',
      toAddresses: ['ops@example.com'],
    };
    await strategy.send(connection, buildSuccess);

    expect(resend.send).toHaveBeenCalledTimes(1);
    const [conn, subject, html] = resend.send.mock.calls[0] as [
      unknown,
      string,
      string,
    ];
    expect(conn).toBe(connection);
    expect(subject).toBe('Build success for Cloudgate');
    expect(html).toContain('storefront');
  });

  it('attaches the header logo once, inline, for the cid: image the html references', async () => {
    const resend = { send: jest.fn().mockResolvedValue(undefined) };

    await new ResendChannelStrategy(resend as never).send(
      { apiKey: 're_x', fromAddress: 'a@b.c', toAddresses: ['ops@b.c'] },
      buildSuccess,
    );

    const [, , html, attachments] = resend.send.mock.calls[0] as [
      unknown,
      string,
      string,
      { cid?: string; contentType?: string }[],
    ];
    expect(html).toContain('src="cid:cloudgate-logo"');
    expect(attachments).toEqual([
      expect.objectContaining({
        cid: 'cloudgate-logo',
        contentType: 'image/png',
      }),
    ]);
  });
});

describe('event formats beyond build-success (slack literals, per-trigger payloads)', () => {
  const slackConnection = {
    webhookUrl: 'https://hooks.slack.com/x',
    channel: '#ops',
  };
  const slackAttachment = async (
    event: Parameters<SlackChannelStrategy['send']>[1],
  ) => {
    const strategy = new SlackChannelStrategy(fetchMock as never);
    await strategy.send(slackConnection, event);
    const body = jsonBody() as { attachments: Record<string, unknown>[] };
    return body.attachments[0];
  };

  it('build-error: red attachment with fenced error and build link', async () => {
    expect(await slackAttachment(buildError)).toEqual({
      color: '#FF0000',
      pretext: ':warning: *Build Failed*',
      fields: [
        { title: 'Project', value: 'shop', short: true },
        { title: 'Application', value: 'storefront', short: true },
        { title: 'Type', value: 'application', short: true },
        { title: 'Time', value: '2026-07-24 10:30:00 UTC', short: true },
        { title: 'Error', value: '```npm exited 1```', short: false },
        {
          title: 'Details',
          value:
            '<https://cloudgate.example.com/deployments/42|View Build Details>',
          short: false,
        },
      ],
      mrkdwn_in: ['fields'],
    });
  });

  it('database-backup failure: error message leads the fields', async () => {
    expect(await slackAttachment(databaseBackupFailed)).toEqual({
      color: '#FF0000',
      pretext: ':x: *Database Backup Failed*',
      fields: [
        {
          title: 'Error Message',
          value: 'pg_dump: connection refused',
          short: false,
        },
        { title: 'Project', value: 'shop', short: true },
        { title: 'Application', value: 'orders-db', short: true },
        { title: 'Type', value: 'postgres', short: true },
        { title: 'Database Name', value: 'orders' },
        { title: 'Time', value: '2026-07-24 10:30:00 UTC', short: true },
        { title: 'Type', value: 'error' },
        { title: 'Status', value: 'Failed' },
      ],
    });
  });

  it('volume-backup success: green attachment with volume/service/size fields', async () => {
    expect(await slackAttachment(volumeBackupSucceeded)).toEqual({
      color: '#00FF00',
      pretext: ':white_check_mark: *Volume Backup Successful*',
      fields: [
        { title: 'Project', value: 'shop', short: true },
        { title: 'Application', value: 'storefront', short: true },
        { title: 'Volume Name', value: 'data', short: true },
        { title: 'Service Type', value: 'application', short: true },
        { title: 'Backup Size', value: '42 MB', short: true },
        { title: 'Time', value: '2026-07-24 10:30:00 UTC', short: true },
        { title: 'Type', value: 'success', short: true },
        { title: 'Status', value: 'Successful', short: true },
      ],
    });
  });

  it('docker-cleanup: message and time', async () => {
    expect(await slackAttachment(dockerCleanup)).toEqual({
      color: '#00FF00',
      pretext: ':white_check_mark: *Docker Cleanup*',
      fields: [
        { title: 'Message', value: 'Removed 5 images' },
        { title: 'Time', value: '2026-07-24 10:30:00 UTC', short: true },
      ],
    });
  });

  it('server-threshold: alert fields with percentages, dated from the event timestamp', async () => {
    expect(await slackAttachment(serverThreshold)).toEqual({
      color: '#FF0000',
      pretext: ':warning: *Server CPU Alert*',
      fields: [
        { title: 'Server Name', value: 'Remote', short: true },
        { title: 'Type', value: 'CPU', short: true },
        { title: 'Current Value', value: '92.50%', short: true },
        { title: 'Threshold', value: '80.00%', short: true },
        { title: 'Message', value: 'CPU usage high' },
        { title: 'Time', value: '2026-07-24 09:00:00 UTC', short: true },
      ],
    });
  });

  it('instance-backup success: Cloudgate-branded backup attachment', async () => {
    expect(await slackAttachment(instanceBackup)).toEqual({
      color: '#00FF00',
      pretext: ':white_check_mark: *Cloudgate Backup Successful*',
      fields: [
        {
          title: 'Backup Type',
          value: 'Complete Cloudgate Instance',
          short: true,
        },
        { title: 'Backup Size', value: '120 MB', short: true },
        { title: 'Time', value: '2026-07-24 10:30:00 UTC', short: true },
        { title: 'Status', value: 'Successful', short: true },
      ],
    });
  });

  it('license-lapse: alert naming the organization, the expiry and each stranded member', async () => {
    expect(await slackAttachment(licenseLapse)).toEqual({
      color: '#FF0000',
      pretext: ':warning: *Enterprise License Lapsed*',
      fields: [
        { title: 'Organization', value: 'Acme', short: true },
        { title: 'Expired', value: '2026-08-01 00:00:00 UTC', short: true },
        {
          title: 'Stopped',
          value:
            'SSO sign-in\n' +
            'Adding members through SCIM\n' +
            'Changes to forward auth\n' +
            'Custom roles\n' +
            'Editing white-labelling (the saved branding stays)\n' +
            'Parallel builds and Cloud runs (back to one at a time)\n' +
            'Creating more Organizations',
        },
        {
          title: 'Locked Out (2)',
          value:
            'Ida Rhodes (ida@example.com) — read-only\n' +
            'Jean Bartik (jean@example.com) — deployer',
        },
        { title: 'Message', value: licenseLapse.message },
      ],
      mrkdwn_in: ['fields'],
    });
  });

  it('license-expiring: warning naming the organization, the expiry and the days left', async () => {
    expect(await slackAttachment(licenseExpiring)).toEqual({
      color: '#FFA500',
      pretext: ':hourglass: *Enterprise License Expiring*',
      fields: [
        { title: 'Organization', value: 'Acme', short: true },
        { title: 'Expires', value: '2026-08-01 00:00:00 UTC', short: true },
        { title: 'Days Left', value: '3', short: true },
        { title: 'Message', value: EXPIRING_GUIDANCE },
      ],
      mrkdwn_in: ['fields'],
    });
  });

  it('instance-restart: Cloudgate-branded restart attachment', async () => {
    expect(await slackAttachment(instanceRestart)).toEqual({
      color: '#00FF00',
      pretext: ':white_check_mark: *Cloudgate Server Restarted*',
      fields: [
        { title: 'Time', value: '2026-07-24 10:30:00 UTC', short: true },
      ],
    });
  });
});

describe('event formats beyond build-success (custom webhook payloads)', () => {
  const connection = { endpoint: 'https://internal.example.com/hook' };

  it('build-error payload', async () => {
    const strategy = new CustomChannelStrategy(fetchMock as never);
    await strategy.send(connection, buildError);

    expect(jsonBody()).toEqual({
      title: 'Build Error',
      message: 'Build failed with errors',
      projectName: 'shop',
      applicationName: 'storefront',
      applicationType: 'application',
      errorMessage: 'npm exited 1',
      buildLink: 'https://cloudgate.example.com/deployments/42',
      timestamp: pinnedNow.toISOString(),
      date: '2026-07-24 10:30:00 UTC',
      status: 'error',
      type: 'build',
    });
  });

  it('database-backup payload', async () => {
    const strategy = new CustomChannelStrategy(fetchMock as never);
    await strategy.send(connection, databaseBackupFailed);

    expect(jsonBody()).toEqual({
      title: 'Database Backup Failed',
      message: 'Database backup failed',
      projectName: 'shop',
      applicationName: 'orders-db',
      databaseType: 'postgres',
      databaseName: 'orders',
      type: 'error',
      errorMessage: 'pg_dump: connection refused',
      timestamp: pinnedNow.toISOString(),
      date: '2026-07-24 10:30:00 UTC',
      status: 'error',
    });
  });
});

describe('event emails beyond build-success (subjects and skip rules)', () => {
  const smtpConnection = {
    smtpServer: 'smtp.example.com',
    smtpPort: 587,
    username: 'mailer',
    password: 'secret',
    fromAddress: 'noreply@example.com',
    toAddresses: ['ops@example.com'],
  };

  it.each([
    [buildError, 'Build failed for Cloudgate'],
    [databaseBackupFailed, 'Database backup for Cloudgate'],
    [volumeBackupSucceeded, 'Volume Backup Successful - storefront'],
    [dockerCleanup, 'Docker cleanup for Cloudgate'],
    [instanceBackup, 'Cloudgate instance backup'],
    [instanceRestart, 'Cloudgate Server Restarted'],
  ] as const)('%o renders subject %s', async (event, subject) => {
    const smtp = { send: jest.fn().mockResolvedValue(undefined) };
    const strategy = new EmailChannelStrategy(smtp as never);

    await strategy.send(smtpConnection, event);

    expect(smtp.send).toHaveBeenCalledWith(
      smtpConnection,
      subject,
      expect.stringContaining('<!DOCTYPE html'),
      [expect.objectContaining({ cid: 'cloudgate-logo' })],
    );
  });

  it('server-threshold is never emailed', async () => {
    const smtp = { send: jest.fn() };
    const strategy = new EmailChannelStrategy(smtp as never);

    await strategy.send(smtpConnection, serverThreshold);

    expect(smtp.send).not.toHaveBeenCalled();
  });

  it('server-threshold is skipped by gotify and ntfy', async () => {
    const gotify = new GotifyChannelStrategy(fetchMock as never);
    await gotify.send(
      { serverUrl: 'https://g', appToken: 't', priority: 5, decoration: null },
      serverThreshold,
    );
    const ntfy = new NtfyChannelStrategy(fetchMock as never);
    await ntfy.send(
      { serverUrl: 'https://n', topic: 't', accessToken: null, priority: 3 },
      serverThreshold,
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/**
 * An event a strategy has no `case` for falls through
 * to `return null` and is **silently skipped** — so an event wired into the
 * dispatcher but only half the formats compiles, passes a dispatcher test, and
 * tells nobody on the channel they actually watch.
 *
 * So every event type the union declares is driven through every strategy the
 * registry holds, and each pair must put something on the wire. Both axes are
 * held by construction: `EVERY_EVENT` is typed as a record over
 * `NotificationEvent['type']`, so a new event without a fixture does not
 * compile, and the channel list is held equal to the registry's enum, so a
 * thirteenth channel without a format fails here. The pairs a channel skips on
 * purpose are listed in `DELIBERATE_SKIPS`, and each is asserted to still
 * skip — an entry that has started delivering is stale and fails too.
 *
 * The two events whose substance is load-bearing — the lapse, which says why
 * nobody was moved off their role, and the rate-limited Agent, which says how
 * to stop it — also assert their words arrive, rather than a per-channel
 * payload literal, because what matters is that the words arrive, not the
 * punctuation they arrive in.
 */
describe('EVENT_FLAG_COLUMNS, every event on every channel', () => {
  const smtpConnection = {
    smtpServer: 'smtp.example.com',
    smtpPort: 587,
    username: 'mailer',
    password: 'secret',
    fromAddress: 'noreply@example.com',
    toAddresses: ['ops@example.com'],
  };

  /**
   * Everything one fetch-backed strategy put on the wire, as one string, or
   * `null` when it sent nothing.
   */
  const transmitted = async (send: Promise<void>): Promise<string | null> => {
    await send;
    if (fetchMock.mock.calls.length === 0) return null;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      string,
      { body?: string | URLSearchParams; headers?: Record<string, string> },
    ];
    // pushover form-posts; every other channel sends a JSON string.
    const body =
      init.body instanceof URLSearchParams
        ? JSON.stringify(Object.fromEntries(init.body))
        : (init.body ?? '');
    return [url, JSON.stringify(init.headers ?? {}), body].join('\n');
  };

  /** What a mail transport was handed, or `null` when it was not called. */
  const mailed = (send: jest.Mock): string | null => {
    if (send.mock.calls.length === 0) return null;
    expect(send).toHaveBeenCalledTimes(1);
    const [, subject, html] = send.mock.calls[0] as [unknown, string, string];
    return `${subject}\n${html}`;
  };

  type Deliver = (event: NotificationEvent) => Promise<string | null>;

  const deliveries: Record<NotificationType, Deliver> = {
    slack: (event) =>
      transmitted(
        new SlackChannelStrategy(fetchMock as never).send(
          { webhookUrl: 'https://hooks.slack.com/x', channel: '#ops' },
          event,
        ),
      ),
    telegram: (event) =>
      transmitted(
        new TelegramChannelStrategy(fetchMock as never).send(
          { botToken: '123:ABC', chatId: '-100', messageThreadId: null },
          event,
        ),
      ),
    discord: (event) =>
      transmitted(
        new DiscordChannelStrategy(fetchMock as never).send(
          {
            webhookUrl: 'https://discord.com/api/webhooks/1/X',
            decoration: true,
          },
          event,
        ),
      ),
    gotify: (event) =>
      transmitted(
        new GotifyChannelStrategy(fetchMock as never).send(
          {
            serverUrl: 'https://gotify.example.com',
            appToken: 'TOKEN',
            priority: 8,
            decoration: true,
          },
          event,
        ),
      ),
    ntfy: (event) =>
      transmitted(
        new NtfyChannelStrategy(fetchMock as never).send(
          {
            serverUrl: 'https://ntfy.sh',
            topic: 'alerts',
            accessToken: null,
            priority: 4,
          },
          event,
        ),
      ),
    mattermost: (event) =>
      transmitted(
        new MattermostChannelStrategy(fetchMock as never).send(
          {
            webhookUrl: 'https://mm.example.com/hooks/X',
            channel: 'ops',
            username: null,
          },
          event,
        ),
      ),
    pushover: (event) =>
      transmitted(
        new PushoverChannelStrategy(fetchMock as never).send(
          {
            userKey: 'USER',
            apiToken: 'TOKEN',
            priority: 1,
            retry: null,
            expire: null,
          },
          event,
        ),
      ),
    custom: (event) =>
      transmitted(
        new CustomChannelStrategy(fetchMock as never).send(
          { endpoint: 'https://internal.example.com/hook', headers: null },
          event,
        ),
      ),
    lark: (event) =>
      transmitted(
        new LarkChannelStrategy(fetchMock as never).send(
          { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/X' },
          event,
        ),
      ),
    teams: (event) =>
      transmitted(
        new TeamsChannelStrategy(fetchMock as never).send(
          { webhookUrl: 'https://outlook.office.com/webhook/X' },
          event,
        ),
      ),
    email: async (event) => {
      const smtp = { send: jest.fn().mockResolvedValue(undefined) };
      await new EmailChannelStrategy(smtp as never).send(smtpConnection, event);
      return mailed(smtp.send);
    },
    resend: async (event) => {
      const resend = { send: jest.fn().mockResolvedValue(undefined) };
      await new ResendChannelStrategy(resend as never).send(
        { apiKey: 're_x', fromAddress: 'a@b.c', toAddresses: ['ops@b.c'] },
        event,
      );
      return mailed(resend.send);
    },
  };

  /** One fixture per event type. A new event does not compile until it has one. */
  const EVERY_EVENT: {
    [T in NotificationEvent['type']]: Extract<NotificationEvent, { type: T }>;
  } = {
    'app-deploy': buildSuccess,
    'app-build-error': buildError,
    'database-backup': databaseBackupFailed,
    'volume-backup': volumeBackupSucceeded,
    'docker-cleanup': dockerCleanup,
    'server-threshold': serverThreshold,
    'instance-backup': instanceBackup,
    'instance-restart': instanceRestart,
    'license-lapse': licenseLapse,
    'license-expiring': licenseExpiring,
    'agent-rate-limited': agentRateLimited,
    'preview-teardown-stuck': previewTeardownStuck,
    'service-incident': serviceIncidentOpened,
    'ai-model-not-answering': aiModelNotAnswering,
  };

  /**
   * The pairs that send nothing on purpose, frozen as they were found when the census
   * made this a census. The only correct edit is a deletion: a new event
   * reaches every channel.
   */
  const DELIBERATE_SKIPS: readonly (readonly [
    NotificationEvent['type'],
    NotificationType,
  ])[] = [
    // A metrics threshold alert is a chat-channel event: the email renderer and
    // the gotify and ntfy formats have never carried one (their `default:`
    // comments say so), and the census did not change what an operator hears.
    ['server-threshold', 'gotify'],
    ['server-threshold', 'ntfy'],
    ['server-threshold', 'email'],
    ['server-threshold', 'resend'],
  ];

  const skipped = (type: string, channel: string) =>
    DELIBERATE_SKIPS.some(([t, c]) => t === type && c === channel);

  const pairs = (Object.keys(EVERY_EVENT) as NotificationEvent['type'][])
    .flatMap((type) =>
      (Object.keys(deliveries) as NotificationType[]).map(
        (channel) => [type, channel] as const,
      ),
    )
    .filter(([type, channel]) => !skipped(type, channel));

  // The registry has twelve channels; a format missing from any one of them is
  // an operator who is never told.
  it('covers every channel the registry can dispatch to', () => {
    expect(Object.keys(deliveries).sort()).toEqual(
      [...notificationType.enumValues].sort(),
    );
  });

  it('holds a fixture for every event a channel can be opted into', () => {
    expect(Object.keys(EVERY_EVENT).sort()).toEqual(
      Object.keys(EVENT_FLAG_COLUMNS).sort(),
    );
    // Fourteen with license-expiring: a fifteenth event is a
    // reviewed edit of this number, not one that rides in on its fixture.
    expect(Object.keys(EVENT_FLAG_COLUMNS)).toHaveLength(14);
  });

  it.each(pairs)('%s reaches %s', async (type, channel) => {
    const sent = await deliveries[channel](EVERY_EVENT[type]);

    expect(sent).not.toBeNull();
    expect(sent!.length).toBeGreaterThan(0);
  });

  it.each(DELIBERATE_SKIPS)(
    '%s still sends nothing on %s',
    async (type, channel) => {
      expect(await deliveries[channel](EVERY_EVENT[type])).toBeNull();
    },
  );

  it.each(Object.entries(deliveries))(
    '%s names the organization, every stranded member and the reason for a lapse',
    async (_channel, deliver) => {
      const sent = await deliver(licenseLapse);

      for (const fragment of lapseSubstance) {
        expect(sent).toContain(fragment);
      }
    },
  );

  // Every channel lists what stopped, so a lapse that strands nobody
  // still says what it cost.
  it.each(Object.entries(deliveries))(
    '%s lists everything a lapse stopped',
    async (_channel, deliver) => {
      const sent = await deliver(licenseLapse);

      for (const line of STOPPED_BY_LAPSE) {
        expect(sent).toContain(line);
      }
    },
  );

  // An empty "Locked Out (0)" reads as a rendering fault, and discord refuses
  // an embed field with an empty value outright, which would lose the alert.
  it.each(Object.entries(deliveries))(
    '%s reports a lapse that strands nobody, without a Locked Out part',
    async (_channel, deliver) => {
      const sent = await deliver(licenseLapseStrandingNobody);

      expect(sent).not.toBeNull();
      expect(sent).toContain('Acme');
      expect(sent).toContain('nobody is locked out');
      for (const line of STOPPED_BY_LAPSE) {
        expect(sent).toContain(line);
      }
      expect(sent).not.toMatch(/locked out \(|locked out:|locked out \d/i);
    },
  );

  // Every channel says which license, when it expires, how close that
  // is, and what stops then.
  it.each(Object.entries(deliveries))(
    '%s names the organization, the expiry, the days left and what stops for an expiring license',
    async (_channel, deliver) => {
      const sent = await deliver(licenseExpiring);

      expect(sent).not.toBeNull();
      expect(sent).toContain('Acme');
      expect(sent).toMatch(/expir/i);
      expect(sent).toContain('3');
      for (const line of STOPPED_BY_LAPSE) {
        expect(sent).toContain(line);
      }
    },
  );

  // Telegram parses the body as HTML and rejects an unsupported start tag
  // outright, so a `Name <email>` line would lose the whole message rather
  // than the fragment. No format may emit a bare angle bracket around one.
  it('never puts an email inside angle brackets', async () => {
    for (const deliver of Object.values(deliveries)) {
      fetchMock.mockClear();
      expect(await deliver(licenseLapse)).not.toContain('<ida@example.com>');
    }
  });

  /**
   * A Server threshold's close rides the one `server-threshold` event
   * and flag, so every channel that renders the opening alert renders the
   * close too — and the deliberate skips above skip it the same way.
   */
  describe('server-threshold close', () => {
    const recovered: ServerThresholdEvent = {
      ...serverThreshold,
      serverName: 'worker-7',
      value: 41.25,
      threshold: 80,
      message: 'CPU usage (41.25%) is back at or under threshold (80.00%)',
      close: {
        reason: 'recovered',
        breachedSince: '2026-07-24T08:15:00.000Z',
      },
    };
    const turnedOff: ServerThresholdEvent = {
      ...recovered,
      threshold: 0,
      message: 'CPU threshold was turned off while breached; usage is 41.25%',
      close: { ...recovered.close!, reason: 'turned-off' },
    };
    const rendering = pairs
      .filter(([type]) => type === 'server-threshold')
      .map(([, channel]) => channel);

    it.each(rendering)(
      'a recovered close reaches %s naming the Server, metric, value, threshold and when it opened',
      async (channel) => {
        const sent = await deliveries[channel](recovered);

        for (const fragment of [
          'Server CPU Recovered',
          'worker-7',
          '41.25%',
          '80.00%',
          ...(channel === 'custom'
            ? // The machine-facing channel keeps the reason and the time
              // structured, as it keeps the opening alert's `status`.
              [
                '"breachedSince":"2026-07-24T08:15:00.000Z"',
                '"status":"recovered"',
              ]
            : ['2026-07-24 08:15:00 UTC', 'Recovered']),
        ]) {
          expect(sent).toContain(fragment);
        }
        expect(sent).not.toContain('Server CPU Alert');
      },
    );

    it.each(rendering)(
      'a turned-off close reaches %s saying it was turned off',
      async (channel) => {
        const sent = await deliveries[channel](turnedOff);

        for (const fragment of [
          'Server CPU Alert Turned Off',
          'worker-7',
          '41.25%',
          channel === 'custom' ? '"status":"turned-off"' : 'Turned off',
        ]) {
          expect(sent).toContain(fragment);
        }
        expect(sent).not.toContain('0.00%');
      },
    );

    it.each(rendering)(
      'the opening alert on %s carries no close fields',
      async (channel) => {
        const sent = await deliveries[channel](serverThreshold);

        expect(sent).toContain('Server CPU Alert');
        expect(sent).not.toContain('Recovered');
        expect(sent).not.toContain('Breached');
      },
    );

    it.each(DELIBERATE_SKIPS.filter(([type]) => type === 'server-threshold'))(
      '%s still sends nothing on %s for a close',
      async (_type, channel) => {
        expect(await deliveries[channel](recovered)).toBeNull();
      },
    );
  });

  describe('agent-rate-limited', () => {
    it.each(Object.entries(deliveries))(
      '%s names the Agent, Organization, budget and key, says how to stop it, and links to its row',
      async (_channel, deliver) => {
        const sent = await deliver(agentRateLimited);

        for (const fragment of rateLimitedSubstance) {
          expect(sent).toContain(fragment);
        }
      },
    );

    it.each(Object.entries(deliveries))(
      '%s leaves the link out when the instance URL is unset',
      async (_channel, deliver) => {
        const unlinked: AgentRateLimitedEvent = { ...agentRateLimited };
        delete unlinked.agentLink;

        const sent = await deliver(unlinked);

        expect(sent).not.toBeNull();
        expect(sent).toContain('loop-bot');
        expect(sent).not.toContain('/settings/agents');
      },
    );

    /**
     * The Agent's name is whatever an owner or admin typed, and each channel
     * with markup reads it as markup: a name that opens a tag refuses the
     * whole telegram message, and `<!channel>` pages a whole slack channel.
     * Each is escaped at the channel, the only place that knows its own
     * markup (the escaping rule).
     */
    const poisoned: AgentRateLimitedEvent = {
      ...agentRateLimited,
      agentName: '<b>loop</b> *bot* <!channel> [x](https://evil.example)',
    };

    // As the wire carries them: every body here is JSON, so the one backslash
    // a markdown escape adds reads as two.
    const markdown: [string[], string[]] = [
      ['\\\\*bot\\\\*', '\\\\[x\\\\]\\\\(https://evil.example\\\\)'],
      ['[x](https://evil.example)', ' *bot* '],
    ];

    /** Per channel: what the escaped name reads as, and what must not appear raw. */
    it.each<[NotificationType, [string[], string[]]]>([
      ['telegram', [['&lt;b&gt;loop&lt;/b&gt;'], ['<b>loop']]],
      [
        'slack',
        [
          ['&lt;!channel&gt;', '&lt;b&gt;loop'],
          ['<!channel>', '<b>loop'],
        ],
      ],
      ['discord', markdown],
      ['mattermost', markdown],
      ['teams', markdown],
      ['lark', markdown],
    ])(
      '%s escapes the Agent name for its markup',
      async (channel, [escaped, raw]) => {
        const sent = await deliveries[channel](poisoned);

        for (const fragment of escaped) expect(sent).toContain(fragment);
        for (const fragment of raw) expect(sent).not.toContain(fragment);
      },
    );
  });

  describe('preview-teardown-stuck', () => {
    it.each(Object.entries(deliveries))(
      '%s names the Server, the count, the Applications holding the slots, and that the slots stay taken',
      async (_channel, deliver) => {
        const sent = await deliver(previewTeardownStuck);

        for (const fragment of teardownStuckSubstance) {
          expect(sent).toContain(fragment);
        }
      },
    );

    /**
     * The Server's and the Applications' names are operator-typed, and read as
     * markup by the channels that have it (the escaping rule). Cloudgate's own `(2)`
     * beside a name is not escaped, which the substance above holds.
     */
    const poisoned: PreviewTeardownStuckEvent = {
      ...previewTeardownStuck,
      serverName: '<b>edge</b> <!channel>',
      applications: [{ name: '*shop* [x](https://evil.example)', stuck: 2 }],
    };

    // As the wire carries them: every body here is JSON, so the one backslash
    // a markdown escape adds reads as two.
    const markdown: [string[], string[]] = [
      ['\\\\*shop\\\\* \\\\[x\\\\]\\\\(https://evil.example\\\\) (2)'],
      ['[x](https://evil.example)', '*shop* '],
    ];

    it.each<[NotificationType, [string[], string[]]]>([
      ['telegram', [['&lt;b&gt;edge&lt;/b&gt;'], ['<b>edge']]],
      [
        'slack',
        [
          ['&lt;!channel&gt;', '&lt;b&gt;edge'],
          ['<!channel>', '<b>edge'],
        ],
      ],
      ['discord', markdown],
      ['mattermost', markdown],
      ['teams', markdown],
      ['lark', markdown],
    ])(
      '%s escapes the Server and Application names for its markup',
      async (channel, [escaped, raw]) => {
        const sent = await deliveries[channel](poisoned);

        for (const fragment of escaped) expect(sent).toContain(fragment);
        for (const fragment of raw) expect(sent).not.toContain(fragment);
      },
    );
  });

  describe('service-incident', () => {
    it.each(Object.entries(deliveries))(
      '%s names the Service, its Environment, the target, the opening error and the Health tab when an Incident opens',
      async (_channel, deliver) => {
        const sent = await deliver(serviceIncidentOpened);

        expect(sent).toContain('Service Incident Opened');
        for (const fragment of incidentSubstance) {
          expect(sent).toContain(fragment);
        }
      },
    );

    it.each(Object.entries(deliveries))(
      '%s says why an Incident closed',
      async (_channel, deliver) => {
        const sent = await deliver(serviceIncidentClosed);

        expect(sent).toContain('Service Incident Closed');
        expect(sent).toContain('Service stopped');
        for (const fragment of incidentSubstance) {
          expect(sent).toContain(fragment);
        }
      },
    );

    // An Error-rate threshold's Incident names the threshold, the
    // opening window's rate and request count, and on a close the worst rate.
    const thresholdClosed: ServiceIncidentEvent = {
      ...serviceIncidentClosed,
      source: 'error-rate-threshold',
      target: '5 % over 5 minutes',
      openingError: '12.5 % of 40 requests',
      worstRate: '31.3 %',
      reason: 'recovered',
    };

    it.each(Object.entries(deliveries))(
      '%s names the threshold, the window, the opening rate and the Health tab when an Error-rate threshold Incident opens',
      async (_channel, deliver) => {
        const opened = await deliver({
          ...thresholdClosed,
          state: 'opened',
          closedAt: undefined,
          reason: undefined,
          worstRate: undefined,
        });
        expect(opened).toContain('Service Incident Opened');
        for (const fragment of [
          'web',
          'Shop',
          '5 % over 5 minutes',
          '12.5 % of 40 requests',
          '/applications/app_1/health',
        ]) {
          expect(opened).toContain(fragment);
        }
        expect(opened).not.toContain('31.3 %');
      },
    );

    it.each(Object.entries(deliveries))(
      '%s says the worst rate when an Error-rate threshold Incident closes',
      async (_channel, deliver) => {
        const closed = await deliver(thresholdClosed);
        expect(closed).toContain('Service Incident Closed');
        expect(closed).toContain('Recovered');
        expect(closed).toContain('31.3 %');
      },
    );

    it.each(Object.entries(deliveries))(
      '%s leaves the link out when the instance URL is unset',
      async (_channel, deliver) => {
        const unlinked: ServiceIncidentEvent = { ...serviceIncidentOpened };
        delete unlinked.serviceLink;

        const sent = await deliver(unlinked);

        expect(sent).not.toBeNull();
        expect(sent).toContain('shop.example.com');
        expect(sent).not.toContain('/applications/app_1/health');
      },
    );

    /**
     * The Service's, Project's and Environment's names and the Domain are
     * operator-typed, and read as markup by the channels that have it (the escaping
     * rule). Cloudgate's own `status 503` is not escaped.
     */
    const poisoned: ServiceIncidentEvent = {
      ...serviceIncidentOpened,
      serviceName: '<b>web</b> *shop* <!channel> [x](https://evil.example)',
    };

    // As the wire carries them: every body here is JSON, so the one backslash
    // a markdown escape adds reads as two.
    const markdown: [string[], string[]] = [
      ['\\\\*shop\\\\*', '\\\\[x\\\\]\\\\(https://evil.example\\\\)'],
      ['[x](https://evil.example)', ' *shop* '],
    ];

    it.each<[NotificationType, [string[], string[]]]>([
      ['telegram', [['&lt;b&gt;web&lt;/b&gt;'], ['<b>web']]],
      [
        'slack',
        [
          ['&lt;!channel&gt;', '&lt;b&gt;web'],
          ['<!channel>', '<b>web'],
        ],
      ],
      ['discord', markdown],
      ['mattermost', markdown],
      ['teams', markdown],
      ['lark', markdown],
    ])(
      '%s escapes the Service name for its markup',
      async (channel, [escaped, raw]) => {
        const sent = await deliveries[channel](poisoned);

        for (const fragment of escaped) expect(sent).toContain(fragment);
        for (const fragment of raw) expect(sent).not.toContain(fragment);
      },
    );
  });

  describe('ai-model-not-answering', () => {
    it.each(Object.entries(deliveries))(
      '%s names the AI model, its Environment, its model and machine, says what to do, and links to its Model tab',
      async (_channel, deliver) => {
        const sent = await deliver(aiModelNotAnswering);

        for (const fragment of notAnsweringSubstance) {
          expect(sent).toContain(fragment);
        }
      },
    );

    it.each(Object.entries(deliveries))(
      '%s leaves the link out when the instance URL is unset',
      async (_channel, deliver) => {
        const unlinked: AiModelNotAnsweringEvent = { ...aiModelNotAnswering };
        delete unlinked.aiModelLink;

        const sent = await deliver(unlinked);

        expect(sent).not.toBeNull();
        expect(sent).toContain('llama3.1:8b');
        expect(sent).not.toContain('/applications/app_1/model');
      },
    );

    /**
     * The AI model's, Project's, Environment's and Server's names and the
     * model tag are operator-typed, and read as markup by the channels that
     * have it (the escaping rule).
     */
    const poisoned: AiModelNotAnsweringEvent = {
      ...aiModelNotAnswering,
      aiModelName: '<b>llm</b> *chat* <!channel> [x](https://evil.example)',
    };

    // As the wire carries them: every body here is JSON, so the one backslash
    // a markdown escape adds reads as two.
    const markdown: [string[], string[]] = [
      ['\\\\*chat\\\\*', '\\\\[x\\\\]\\\\(https://evil.example\\\\)'],
      ['[x](https://evil.example)', ' *chat* '],
    ];

    it.each<[NotificationType, [string[], string[]]]>([
      ['telegram', [['&lt;b&gt;llm&lt;/b&gt;'], ['<b>llm']]],
      [
        'slack',
        [
          ['&lt;!channel&gt;', '&lt;b&gt;llm'],
          ['<!channel>', '<b>llm'],
        ],
      ],
      ['discord', markdown],
      ['mattermost', markdown],
      ['teams', markdown],
      ['lark', markdown],
    ])(
      '%s escapes the AI model name for its markup',
      async (channel, [escaped, raw]) => {
        const sent = await deliveries[channel](poisoned);

        for (const fragment of escaped) expect(sent).toContain(fragment);
        for (const fragment of raw) expect(sent).not.toContain(fragment);
      },
    );
  });
});

/**
 * High and never emergency, whatever the channel's own priority says:
 * a Pushover channel set to 2 for other events still sends an Incident at 1,
 * because 2 repeats until acknowledged and an Incident is told exactly twice.
 */
describe('SERVICE_INCIDENT_PRIORITY', () => {
  const sentPriority = (): string => {
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body?: string | URLSearchParams; headers?: Record<string, string> },
    ];
    if (init.body instanceof URLSearchParams) {
      return init.body.get('priority') ?? '';
    }
    if (init.headers?.['X-Priority']) return init.headers['X-Priority'];
    return String(
      (JSON.parse(init.body as string) as { priority: number }).priority,
    );
  };

  it('sends an Incident at Pushover priority 1 from a channel set to emergency', async () => {
    await new PushoverChannelStrategy(fetchMock as never).send(
      {
        userKey: 'USER',
        apiToken: 'TOKEN',
        priority: 2,
        retry: 30,
        expire: 3600,
      },
      serviceIncidentOpened,
    );

    expect(sentPriority()).toBe('1');
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    // Nothing of the emergency arm rides along.
    expect(init.body.has('retry')).toBe(false);
  });

  it('keeps a Pushover channel at emergency for every other event', async () => {
    await new PushoverChannelStrategy(fetchMock as never).send(
      {
        userKey: 'USER',
        apiToken: 'TOKEN',
        priority: 2,
        retry: 30,
        expire: 3600,
      },
      agentRateLimited,
    );

    expect(sentPriority()).toBe('2');
  });

  it('sends an Incident at ntfy priority 4 from a channel set to 5', async () => {
    await new NtfyChannelStrategy(fetchMock as never).send(
      {
        serverUrl: 'https://ntfy.sh',
        topic: 'alerts',
        accessToken: null,
        priority: 5,
      },
      serviceIncidentClosed,
    );

    expect(sentPriority()).toBe('4');
  });

  it('sends an Incident at gotify priority 8 from a channel set to 10', async () => {
    await new GotifyChannelStrategy(fetchMock as never).send(
      {
        serverUrl: 'https://gotify.example.com',
        appToken: 'TOKEN',
        priority: 10,
        decoration: true,
      },
      serviceIncidentOpened,
    );

    expect(sentPriority()).toBe('8');
  });
});

describe('LarkChannelStrategy', () => {
  it('posts the build-success interactive card', async () => {
    const strategy = new LarkChannelStrategy(fetchMock as never);

    await strategy.send(
      { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/X' },
      buildSuccess,
    );

    const body = jsonBody() as {
      msg_type: string;
      card: {
        header: { title: { content: string }; template: string };
        body: { elements: unknown[] };
      };
    };
    expect(body.msg_type).toBe('interactive');
    expect(body.card.header.title.content).toBe('✅ Build Success');
    expect(body.card.header.template).toBe('green');
    expect(body.card.body.elements).toHaveLength(2);
    expect(body.card.body.elements[1]).toMatchObject({
      tag: 'button',
      text: { tag: 'plain_text', content: 'View Build Details' },
      behaviors: [
        expect.objectContaining({
          type: 'open_url',
          default_url: 'https://cloudgate.example.com/deployments/42',
        }),
      ],
    });
  });

  /**
   * The last of the twelve to swallow — and the swallow was not the
   * mechanism. `send` never read `response.ok`, so a webhook that refused the
   * card resolved like a delivery and the ported `try/catch` was dead code on
   * the path that mattered; the `catch` had no logger in it either, so a
   * rejected `fetch` was equally silent. Measured before the fix: a
   * `{ ok: false }` response and a rejected `fetch` both made `send` resolve,
   * so `NotificationsService.deliverTest` had nothing to map and "Test
   * connection" answered 200 for a channel that cannot deliver.
   */
  it('reports a non-ok webhook response instead of resolving', async () => {
    fetchMock.mockResolvedValue({ ok: false, statusText: 'Bad Request' });
    const strategy = new LarkChannelStrategy(fetchMock as never);

    await expect(
      strategy.send(
        { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/X' },
        { type: 'test' },
      ),
    ).rejects.toThrow('Failed to send Lark notification: Bad Request');
  });

  it('reports an unreachable webhook instead of swallowing it', async () => {
    fetchMock.mockRejectedValue(new Error('lark is down'));
    const strategy = new LarkChannelStrategy(fetchMock as never);

    await expect(
      strategy.send(
        { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/X' },
        { type: 'test' },
      ),
    ).rejects.toThrow('lark is down');
  });
});

/**
 * H-122. Discord, Lark and Teams are the three channels that cap an error
 * message before it goes into the payload — nine call sites over three caps
 * (800, 1010 and 500) — and every one of them cut in UTF-16 code units, which
 * is not where a character ends.
 */
describe('capMessage — a cap that lands inside a character (H-122)', () => {
  // The two shapes that make a string not well-formed Unicode: a high surrogate
  // with no low one after it, or a low one with no high one before it.
  // `JSON.stringify` escapes exactly these and leaves every paired one literal,
  // so a `\uD800`–`\uDFFF` escape *in the serialized body* is this defect and
  // nothing else — it is the wire shape, read off the wire.
  const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;

  // `🐳` is U+1F433: two code units, which is what `substring` counts. The
  // leading `x` shifts every pair onto an odd offset, so a cut at an even cap —
  // 800, 1010 and 500 all are — falls between the halves of one whale. An error
  // message is a tool's own words on stderr and can be anything at all.
  const astral = (cap: number) => `x${'🐳'.repeat(cap)}`;
  // The control. `⚠` is U+26A0, one code unit, so the same cap over a longer
  // string cuts nothing in half. It has to pass in *both* directions: that is
  // what says the defect is the boundary and not the cap.
  const bmp = (cap: number) => `x${'⚠'.repeat(cap)}`;

  const rawBody = (): string =>
    (fetchMock.mock.calls[0] as [string, { body: string }])[1].body;

  const discord = (event: ChannelEvent) =>
    new DiscordChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      event,
    );
  const lark = (event: ChannelEvent) =>
    new LarkChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/X' },
      event,
    );
  const teams = (event: ChannelEvent) =>
    new TeamsChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://example.webhook.office.com/X' },
      event,
    );

  const backupFailed = (errorMessage: string): VolumeBackupEvent => ({
    ...volumeBackupSucceeded,
    status: 'error',
    errorMessage,
  });
  const instanceBackupFailed = (errorMessage: string): InstanceBackupEvent => ({
    ...instanceBackup,
    status: 'error',
    errorMessage,
  });

  // Every capping call site in the module, with the cap it applies. Nine, not
  // the three the finding named: the property has to hold over the set, which is
  // what H-98 and H-104 were both about.
  const sites: [string, number, (errorMessage: string) => Promise<void>][] = [
    [
      'discord app-build-error',
      800,
      (errorMessage) => discord({ ...buildError, errorMessage }),
    ],
    [
      'discord database-backup',
      1010,
      (errorMessage) => discord({ ...databaseBackupFailed, errorMessage }),
    ],
    [
      'lark app-build-error',
      800,
      (errorMessage) => lark({ ...buildError, errorMessage }),
    ],
    [
      'lark database-backup',
      800,
      (errorMessage) => lark({ ...databaseBackupFailed, errorMessage }),
    ],
    [
      'lark volume-backup',
      800,
      (errorMessage) => lark(backupFailed(errorMessage)),
    ],
    [
      'lark instance-backup',
      800,
      (errorMessage) => lark(instanceBackupFailed(errorMessage)),
    ],
    [
      'teams app-build-error',
      800,
      (errorMessage) => teams({ ...buildError, errorMessage }),
    ],
    [
      'teams database-backup',
      500,
      (errorMessage) => teams({ ...databaseBackupFailed, errorMessage }),
    ],
    [
      'teams volume-backup',
      500,
      (errorMessage) => teams(backupFailed(errorMessage)),
    ],
    // H-124. These three capped at nothing until the number beside them was
    // applied to them too; they join the set rather than getting a table of
    // their own, because the property is the set's.
    [
      'discord volume-backup',
      1010,
      (errorMessage) => discord(backupFailed(errorMessage)),
    ],
    [
      'discord instance-backup',
      1010,
      (errorMessage) => discord(instanceBackupFailed(errorMessage)),
    ],
    [
      'teams instance-backup',
      500,
      (errorMessage) => teams(instanceBackupFailed(errorMessage)),
    ],
  ];

  it.each(sites)(
    '%s sends no lone surrogate when its cap splits a pair',
    async (_site, cap, send) => {
      await send(astral(cap));

      // The cap fired: the whole message is not in the body.
      expect(rawBody()).not.toContain(astral(cap));
      expect(rawBody()).not.toMatch(LONE_SURROGATE_ESCAPE);
    },
  );

  it.each(sites)(
    '%s control: a BMP message the same cap cuts is untouched by the fix',
    async (_site, cap, send) => {
      await send(bmp(cap));

      expect(rawBody()).not.toContain(bmp(cap));
      expect(rawBody()).not.toMatch(LONE_SURROGATE_ESCAPE);
    },
  );

  // The two above say "no lone surrogate". These two say *how*: the boundary
  // steps inwards off the pair, so the answer is one unit short of the cap
  // rather than one over it.
  it('discord ends the 800-unit cap on a whole character, inside the cap', async () => {
    await discord({ ...buildError, errorMessage: astral(800) });

    const { embeds } = jsonBody() as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    const field = embeds[0].fields.find((f) =>
      f.name.includes('Error Message'),
    );
    // ```…``` — the fence discord.strategy.ts wraps the message in.
    const message = field?.value.slice(3, -3) ?? '';
    expect(message).toHaveLength(799);
    expect(message.endsWith('🐳')).toBe(true);
  });

  it('teams ends the 500-unit cap on a whole character, inside the cap', async () => {
    await teams(backupFailed(astral(500)));

    const { attachments } = jsonBody() as {
      attachments: {
        content: { body: { facts?: { title: string; value: string }[] }[] };
      }[];
    };
    const facts = attachments[0].content.body[1].facts ?? [];
    const message = facts.find((f) => f.title === 'Error')?.value ?? '';
    expect(message).toHaveLength(499);
    expect(message.endsWith('🐳')).toBe(true);
  });

  it('control: a BMP message fills the cap exactly', async () => {
    await discord({ ...buildError, errorMessage: bmp(800) });

    const { embeds } = jsonBody() as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    const field = embeds[0].fields.find((f) =>
      f.name.includes('Error Message'),
    );
    expect(field?.value.slice(3, -3)).toHaveLength(800);
  });
});

/**
 * H-124. Three sites sent the error message with no cap at all, while the case
 * directly above them in the same file capped the identical field. Whether a
 * platform rejects an over-long value or truncates it is not sourced anywhere in
 * this tree, so these pin the cap firing, not a platform's response to it.
 */
describe('capMessage — a cap that was never applied (H-124)', () => {
  const long = '⚠'.repeat(5000);

  const discordErrorField = (): string => {
    const { embeds } = jsonBody() as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    const field = embeds[0].fields.find((f) =>
      f.name.includes('Error Message'),
    );
    return field?.value ?? '';
  };

  it('a discord volume-backup failure is capped the way the database-backup beside it is', async () => {
    await new DiscordChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      { ...volumeBackupSucceeded, status: 'error', errorMessage: long },
    );

    // ```<1010>...``` — the same shape, marker included, as the database-backup
    // case in the same file.
    expect(discordErrorField()).toBe(`\`\`\`${'⚠'.repeat(1010)}...\`\`\``);
  });

  it('a discord instance-backup failure is capped the way the database-backup beside it is', async () => {
    await new DiscordChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      { ...instanceBackup, status: 'error', errorMessage: long },
    );

    expect(discordErrorField()).toBe(`\`\`\`${'⚠'.repeat(1010)}...\`\`\``);
  });

  it('a teams instance-backup failure is capped the way its two sibling backups are', async () => {
    await new TeamsChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://example.webhook.office.com/X' },
      { ...instanceBackup, status: 'error', errorMessage: long },
    );

    const { attachments } = jsonBody() as {
      attachments: {
        content: { body: { facts?: { title: string; value: string }[] }[] };
      }[];
    };
    const facts = attachments[0].content.body[1].facts ?? [];
    const message = facts.find((f) => f.title === 'Error Message')?.value ?? '';
    // 500, not the 800 of teams' build-error: this is the third member of the
    // backup family, and the other two cap at 500.
    expect(message).toHaveLength(500);
  });

  // Nothing under the cap is touched: a short failure still arrives whole, with
  // no elision marker invented for it.
  it('a failure under the cap is sent unchanged', async () => {
    await new DiscordChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      { ...instanceBackup, status: 'error', errorMessage: 'tar exited 2' },
    );

    expect(discordErrorField()).toBe('```tar exited 2```');
  });
});

/**
 * Two of the nine channels that capped at nothing now cap at a number
 * their own provider publishes. Both URLs are here as well as at the constant,
 * because a pin whose expected value cannot be checked against the source is
 * the retraction this issue records happening again one file over: the number
 * this issue exists for was offered from memory, could not be found, and was
 * withdrawn.
 *
 * The other seven channels carry a comment at the strategy naming what was
 * looked for and not found, and have nothing to pin here — there is no cap to
 * fire.
 */
describe('capMessage, at the channels whose limit could be sourced', () => {
  // The same wire-shape probe the H-122 block uses: `JSON.stringify` escapes a
  // lone surrogate and leaves every paired one literal, so a `\uD800`–`\uDFFF`
  // escape in the serialized body is that defect and nothing else.
  const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;

  const rawBody = (): string =>
    (fetchMock.mock.calls[0] as [string, { body: string }])[1].body;

  const telegram = (event: ChannelEvent) =>
    new TelegramChannelStrategy(fetchMock as never).send(
      { botToken: '123:ABC', chatId: '-10042', messageThreadId: null },
      event,
    );

  const pushover = (event: ChannelEvent) =>
    new PushoverChannelStrategy(fetchMock as never).send(
      { userKey: 'U', apiToken: 'T', priority: 1, retry: null, expire: null },
      event,
    );

  const pushoverMessage = (): string => {
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    return init.body.get('message') ?? '';
  };

  // Long enough to blow any of these budgets several times over. `⚠` is
  // U+26A0, one code unit, so it is the control shape: nothing here can split
  // a character.
  const longStderr = '⚠'.repeat(10_000);

  // `🐳` is U+1F433, two code units. Where the cut lands depends on the length
  // of the prose the strategy wraps the body in, so each case is sent at both
  // parities — one of the two must put the boundary between the halves of a
  // whale, and neither may leave one behind.
  const parities = [
    ['even offset', '🐳'.repeat(5000)],
    ['odd offset', `x${'🐳'.repeat(5000)}`],
  ] as const;

  /**
   * "Text of the message to be sent, 1-4096 characters after entities parsing"
   * — https://core.telegram.org/bots/api#sendmessage
   *
   * Telegram refuses the whole message rather than truncating it, so every
   * assertion below is on the assembled `text` and not on the field inside it:
   * a 4096-character error message with prose around it is still refused.
   */
  describe('telegram sendMessage text — 4096 characters', () => {
    const TELEGRAM_TEXT_LIMIT = 4096;

    // The four `errorMessage` sites, each of which ends its message with the
    // error inside a `<pre>` block.
    const errorSites: [string, (errorMessage: string) => Promise<void>][] = [
      [
        'app-build-error',
        (errorMessage) => telegram({ ...buildError, errorMessage }),
      ],
      [
        'database-backup',
        (errorMessage) => telegram({ ...databaseBackupFailed, errorMessage }),
      ],
      [
        'volume-backup',
        (errorMessage) =>
          telegram({
            ...volumeBackupSucceeded,
            status: 'error',
            errorMessage,
          }),
      ],
      [
        'instance-backup',
        (errorMessage) =>
          telegram({ ...instanceBackup, status: 'error', errorMessage }),
      ],
    ];

    it.each(errorSites)(
      '%s keeps the whole message inside telegram 4096-character text limit',
      async (_site, send) => {
        await send(longStderr);

        expect((jsonBody().text as string).length).toBeLessThanOrEqual(
          TELEGRAM_TEXT_LIMIT,
        );
      },
    );

    it.each(errorSites)(
      '%s cuts the error and not the HTML around it',
      async (_site, send) => {
        await send(longStderr);

        // `parse_mode: 'HTML'` — a cut landing inside the markup is what turns
        // a truncated notification into a rejected one, so the closing tag
        // surviving is the property, not a detail of the format.
        expect(jsonBody().text as string).toMatch(/<pre>⚠+<\/pre>$/);
      },
    );

    it.each(
      errorSites.flatMap(([site, send]) =>
        parities.map(
          ([parity, body]) =>
            [`${site} (${parity})`, send, body] as [
              string,
              (errorMessage: string) => Promise<void>,
              string,
            ],
        ),
      ),
    )(
      '%s sends no lone surrogate when the budget splits a pair',
      async (_case, send, body) => {
        await send(body);

        const text = jsonBody().text as string;
        expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
        expect(rawBody()).not.toMatch(LONE_SURROGATE_ESCAPE);
        // How, not just whether: the boundary steps back off the pair, so the
        // text still ends in a whole whale and its closing tag.
        expect(text.endsWith('🐳</pre>')).toBe(true);
      },
    );

    // The fifth unbounded body in that file, and the only one that is not an
    // error message: the locked-out list grows with the organization.
    it('a license lapse with more members than the budget holds still fits', async () => {
      await telegram({
        ...licenseLapse,
        strandedMembers: Array.from({ length: 300 }, (_, i) => ({
          name: `Member ${i}`,
          email: `member${i}@example.com`,
          role: 'read-only',
        })),
      });

      const text = jsonBody().text as string;
      expect(text.length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      // The count and the guidance sit either side of the list, so both
      // survive a cut that lands inside it.
      expect(text).toContain('<b>Locked Out:</b> 300');
      expect(text.endsWith(licenseLapse.message)).toBe(true);
    });

    // Nothing under the budget is touched, and no elision marker is invented
    // for it — telegram has no ellipsis convention here, unlike discord.
    it('a failure inside the budget arrives whole', async () => {
      await telegram({ ...buildError, errorMessage: 'npm exited 1' });

      expect(jsonBody().text as string).toContain(
        '<b>Error:</b>\n<pre>npm exited 1</pre>',
      );
    });
  });

  /**
   * "Messages are currently limited to 1024 UTF-8 characters (up to 4 bytes
   * each), with a title of up to 250 characters." — https://pushover.net/api
   *
   * The limit is on the whole `message` parameter, so the cap is applied once
   * to the assembled body and every event is covered by it. UTF-16 code units
   * under a limit stated in characters is the conservative direction: 1024
   * units can never exceed 1024 of pushover's characters.
   */
  describe('pushover message — 1024 characters', () => {
    const PUSHOVER_MESSAGE_LIMIT = 1024;

    const sites: [string, (body: string) => Promise<void>][] = [
      [
        'app-build-error',
        (errorMessage) => pushover({ ...buildError, errorMessage }),
      ],
      [
        'database-backup',
        (errorMessage) => pushover({ ...databaseBackupFailed, errorMessage }),
      ],
      [
        'volume-backup',
        (errorMessage) =>
          pushover({
            ...volumeBackupSucceeded,
            status: 'error',
            errorMessage,
          }),
      ],
      [
        'instance-backup',
        (errorMessage) =>
          pushover({ ...instanceBackup, status: 'error', errorMessage }),
      ],
    ];

    it.each(sites)(
      '%s keeps the message inside pushover 1024-character limit',
      async (_site, send) => {
        await send(longStderr);

        expect(pushoverMessage().length).toBeLessThanOrEqual(
          PUSHOVER_MESSAGE_LIMIT,
        );
      },
    );

    it.each(
      sites.flatMap(([site, send]) =>
        parities.map(
          ([parity, body]) =>
            [`${site} (${parity})`, send, body] as [
              string,
              (body: string) => Promise<void>,
              string,
            ],
        ),
      ),
    )(
      '%s sends no lone surrogate when the cap splits a pair',
      async (_case, send, body) => {
        await send(body);

        const message = pushoverMessage();
        expect(message.length).toBeLessThanOrEqual(PUSHOVER_MESSAGE_LIMIT);
        // Pushover takes a form body rather than JSON, so the JSON escape
        // probe does not apply: the tail says it directly. A whole whale at
        // the end is a message that ends in a character.
        expect(message.endsWith('🐳')).toBe(true);
      },
    );

    it('a license lapse with more members than the limit holds still fits', async () => {
      await pushover({
        ...licenseLapse,
        strandedMembers: Array.from({ length: 300 }, (_, i) => ({
          name: `Member ${i}`,
          email: `member${i}@example.com`,
          role: 'read-only',
        })),
      });

      expect(pushoverMessage().length).toBeLessThanOrEqual(
        PUSHOVER_MESSAGE_LIMIT,
      );
    });

    // The title is documented at 250 and is not capped, because no input
    // reaches it: the longest this file can produce is a literal.
    it('the longest title any event produces is far inside the documented 250', async () => {
      await pushover({ ...databaseBackupFailed, errorMessage: longStderr });

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect(init.body.get('title')).toBe('Database Backup Failed');
    });
  });

  /**
   * Not a new cap — discord's three were settled by H-122 — but the number that
   * says the existing ones are the right shape, and the answer to the one
   * question the cap triage left open: does appending `...` *outside* a 1010 cap
   * overrun the field?
   *
   * It does not. "Field value: 1024 characters", and "Exceeding these
   * constraints results in a Bad Request response" —
   * https://docs.discord.com/developers/resources/message. 1010 plus the two
   * three-character fences plus the three-character ellipsis is 1019, so the
   * cap is a budget for the message with room left for the wrapper, and the
   * wrapper is what fits. Nothing moved inward; this pins that nothing needed
   * to.
   */
  it('a discord backup error field fits inside the 1024-character field limit, fences and ellipsis included', async () => {
    await new DiscordChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      { ...databaseBackupFailed, errorMessage: '⚠'.repeat(10_000) },
    );

    const { embeds } = jsonBody() as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    const value =
      embeds[0].fields.find((f) => f.name.includes('Error Message'))?.value ??
      '';
    expect(value).toHaveLength(1019);
    expect(value.length).toBeLessThanOrEqual(1024);
  });
});

/**
 * `parse_mode: 'HTML'` makes every interpolated value part of the
 * markup, so telegram parses the assembled `text` and answers `ok: false`
 * with the reason in `description` for a body it cannot parse. One `<` in a
 * compiler diagnostic therefore costs the whole notification rather than a
 * glyph — and `<` is ordinary in a C++, XML or JSX diagnostic. Measured
 * before the fix: a build failure reached the wire as
 * `<pre>src/a.tsx(3,10): error TS2322: Type <Foo> & Bar</pre>`.
 *
 * The three rules these tests hold telegram's `text` to, all from
 * https://core.telegram.org/bots/api#html-style:
 *
 * - *"All `<`, `>` and `&` symbols that are not a part of a tag or an HTML
 *   entity must be replaced with the corresponding HTML entities (`<` with
 *   `&lt;`, `>` with `&gt;` and `&` with `&amp;`)"*
 * - *"Only the tags mentioned above are currently supported."*
 * - *"The API currently supports only the following named HTML entities:
 *   `&lt;`, `&gt;`, `&amp;` and `&quot;`"*, and *"All numerical HTML entities
 *   are supported."*
 *
 * `unparsable` is that rule stated independently rather than the strategy's
 * own escaper re-run (§1.7): it strips the tags this file is allowed to emit
 * and then asserts nothing telegram would refuse is left. So it fails for an
 * unescaped field, for an entity the cap cut in half, and equally for a new
 * tag nobody sourced.
 */
describe('escapeHtml, the three symbols telegram refuses a whole message over', () => {
  const TELEGRAM_TEXT_LIMIT = 4096;

  const telegram = (event: ChannelEvent) =>
    new TelegramChannelStrategy(fetchMock as never).send(
      { botToken: '123:ABC', chatId: '-10042', messageThreadId: null },
      event,
    );

  const text = (): string => jsonBody().text as string;

  // The only two tags this file's bodies contain. Both are on telegram's
  // supported list; a tag that is not is what gets a message refused, and a
  // supported tag this file did not previously emit is a change to the markup
  // that ought to be looked at rather than passed.
  const EMITTED_TAGS = /<\/?(?:b|pre)>/g;

  /** Every fragment of `body` telegram would not be able to parse. */
  const unparsable = (body: string): string[] => {
    const stripped = body.replace(EMITTED_TAGS, '');
    return [
      ...stripped.matchAll(
        /[<>]|&(?!lt;|gt;|amp;|quot;|#\d+;|#x[\da-fA-F]+;)/g,
      ),
    ].map((match) => stripped.slice(match.index, match.index + 16));
  };

  // Every string field of every event, carrying all three symbols. `<b x="1">`
  // and `<Foo>` are the two shapes that matter — one opens a tag telegram
  // recognises and one does not — and the `&` is here because `&amp;` is the
  // escape the cap can cut in half.
  const poison = 'a <Foo> & <b x="1"> b';

  const poisoned: ChannelEvent[] = [
    { type: 'test' },
    {
      ...buildSuccess,
      projectName: poison,
      applicationName: poison,
      environmentName: poison,
      applicationType: poison,
    },
    {
      ...buildError,
      projectName: poison,
      applicationName: poison,
      applicationType: poison,
      errorMessage: poison,
    },
    {
      ...databaseBackupFailed,
      projectName: poison,
      applicationName: poison,
      databaseType: poison,
      databaseName: poison,
      errorMessage: poison,
    },
    {
      ...volumeBackupSucceeded,
      status: 'error',
      projectName: poison,
      applicationName: poison,
      volumeName: poison,
      serviceType: poison,
      backupSize: poison,
      errorMessage: poison,
    },
    { ...dockerCleanup, message: poison },
    { ...serverThreshold, serverName: poison, message: poison },
    {
      ...instanceBackup,
      status: 'error',
      backupSize: poison,
      errorMessage: poison,
    },
    {
      ...licenseLapse,
      organizationName: poison,
      message: poison,
      strandedMembers: [{ name: poison, email: poison, role: poison }],
    },
    instanceRestart,
    {
      ...aiModelNotAnswering,
      aiModelName: poison,
      projectName: poison,
      environmentName: poison,
      model: poison,
      serverName: poison,
    },
  ];

  // Every interpolated site, not only the one the issue named: the fix is a
  // property of the file rather than of `errorMessage`, and an eleventh event
  // that interpolates a field raw fails here.
  it.each(poisoned.map((event) => [event.type, event] as const))(
    '%s sends nothing telegram would refuse to parse',
    async (_type, event) => {
      await telegram(event);

      expect(unparsable(text())).toEqual([]);
    },
  );

  it('escapes a build failure whose diagnostic contains an angle bracket', async () => {
    await telegram({
      ...buildError,
      errorMessage: 'error TS2322: Type <Foo> & Bar',
    });

    expect(text()).toContain(
      '<b>Error:</b>\n<pre>error TS2322: Type &lt;Foo&gt; &amp; Bar</pre>',
    );
  });

  // `notification-event.ts` reasoned that the license-lapse fields emit no
  // bare angle bracket. That was true of `describeStrandedMember`'s template
  // and false of the values it interpolates: a display name is whatever the
  // account holder typed.
  it('escapes a stranded member whose display name carries an angle bracket', async () => {
    await telegram({
      ...licenseLapse,
      strandedMembers: [
        { name: 'Ada <Lovelace>', email: 'ada@example.com', role: 'read-only' },
      ],
    });

    expect(text()).toContain(
      '• Ada &lt;Lovelace&gt; (ada@example.com) — read-only',
    );
  });

  // The other half of the same rule: `reply_markup` is JSON that telegram
  // never parses as HTML, so escaping it would put `&amp;` in a hostname.
  it('leaves the inline-keyboard alone, which is JSON and not HTML', async () => {
    await telegram({
      ...buildSuccess,
      buildLink: undefined,
      domains: [{ host: 'a&b.example.com', https: true }],
    });

    expect(jsonBody().reply_markup).toEqual({
      inline_keyboard: [
        [{ text: 'a&b.example.com', url: 'https://a&b.example.com' }],
      ],
    });
  });

  /**
   * The interaction with the 4096-character cap, which is taken on the
   * whole `text`. Escaping expands — one `&` becomes five units — so it has
   * to happen *before* the cut, or the budget the cut just bought is spent
   * again by the escape and telegram refuses the length instead. Cutting
   * escaped text costs the other hazard: a cut inside `&amp;` leaves `&am`,
   * which is *"not a part of a tag or an HTML entity"* and is not one of the
   * four names telegram supports, so it is refused for the same reason a bare
   * `<` is.
   */
  describe('the budget is spent on escaped text, and the cut never ends inside an entity', () => {
    // 10,000 `<` escape to 40,000 units of `&lt;`, ten times the whole
    // budget. Whether the cut lands between the `&` and the `;` depends on
    // the prose length, so all four offsets are sent: exactly three of the
    // four put the boundary inside an entity.
    it.each([0, 1, 2, 3])(
      'a build failure of angle brackets at offset %i fits, and ends on a whole entity',
      async (offset) => {
        await telegram({
          ...buildError,
          errorMessage: 'y'.repeat(offset) + '<'.repeat(10_000),
        });

        // Escaping after the cut would put a 4096-unit body through a
        // five-fold expansion, so this length is the order-of-operations
        // assertion and not a restatement of the cap.
        expect(text().length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
        expect(unparsable(text())).toEqual([]);
        expect(text().endsWith('&lt;</pre>')).toBe(true);
      },
    );

    it('a license lapse whose members carry angle brackets fits and stays parsable', async () => {
      await telegram({
        ...licenseLapse,
        strandedMembers: Array.from({ length: 300 }, (_, i) => ({
          name: `<Member ${i}>`,
          email: `member${i}@example.com`,
          role: 'read&only',
        })),
      });

      expect(text().length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
      expect(unparsable(text())).toEqual([]);
      // The count and the guidance sit either side of the list, so both
      // survive a cut that lands inside it.
      expect(text()).toContain('<b>Locked Out:</b> 300');
      expect(text().endsWith(licenseLapse.message)).toBe(true);
    });
  });

  /**
   * Mechanism 2. The refusal above was invisible, and by a wider margin than
   * the swallow alone: `send` never looked at the response, so a 400 from
   * `sendMessage` resolved like a delivery and the ported `try/catch` — which
   * only logged — was never reached at all. Measured before the fix:
   * `logger.error` was called zero times for a non-ok response.
   *
   * `NotificationDispatcherService.dispatch` already wraps each channel in
   * its own `try/catch`, logging the row's name and type and moving to the
   * next, so throwing here costs the other channels nothing — and
   * `NotificationsService.deliverTest` maps a throw to the 400 that makes
   * "Test connection" answer truthfully.
   */
  describe('a refused delivery', () => {
    it('reports a non-ok sendMessage response instead of resolving', async () => {
      fetchMock.mockResolvedValue({ ok: false, statusText: 'Bad Request' });

      await expect(telegram({ type: 'test' })).rejects.toThrow(
        'Failed to send Telegram notification: Bad Request',
      );
    });
  });
});

/**
 * The `Locked Out` field joined every stranded member into **one** embed
 * field value with no cap. Discord's own limit on that value is *"field.value
 * | 1024 characters"*, and *"Violating any of these constraints will result in
 * a `Bad Request` response"* —
 * https://docs.discord.com/developers/resources/message#embed-object-embed-limits
 * — so the alert became less deliverable as the lapse got more serious.
 * Measured before the fix: 22 stranded members produced a 1,123-unit value,
 * and 100 produced 5,179.
 */
describe('lockedOutField, discord 1024-character embed field value', () => {
  const DISCORD_FIELD_VALUE_LIMIT = 1024;

  const discord = (event: ChannelEvent) =>
    new DiscordChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      event,
    );

  const lockedOut = (): string => {
    const { embeds } = jsonBody() as {
      embeds: { fields: { name: string; value: string }[] }[];
    };
    return (
      embeds[0].fields.find((field) => field.name.includes('Locked Out'))
        ?.value ?? ''
    );
  };

  const members = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      name: `Member Number ${i}`,
      email: `member${i}@example.com`,
      role: 'read-only',
    }));

  it('caps a lapse that strands more members than the field holds', async () => {
    await discord({ ...licenseLapse, strandedMembers: members(300) });

    expect(lockedOut().length).toBeLessThanOrEqual(DISCORD_FIELD_VALUE_LIMIT);
  });

  // A silently truncated list of the people who have just lost access is a
  // bad answer by itself, so the cut says how many it dropped. The count is
  // checked against the members actually rendered, matched here rather than
  // recomputed the way the strategy counts them.
  it('names how many stranded members the cut dropped', async () => {
    await discord({ ...licenseLapse, strandedMembers: members(300) });

    const value = lockedOut();
    const shown = value.match(
      /Member Number \d+ \(member\d+@example\.com\) — read-only/g,
    );
    const marker = /\n\.\.\.and (\d+) more$/.exec(value);

    expect(marker).not.toBeNull();
    expect(shown?.length).toBeGreaterThan(0);
    // Nothing was lost quietly: what arrived plus what the marker names is
    // everyone who was locked out.
    expect(Number(marker?.[1]) + (shown?.length ?? 0)).toBe(300);
    // No half-rendered member: the one the cut landed inside is dropped, so
    // the list never reads as a member whose address is `member19@exa`.
    expect(value.replace(/\n\.\.\.and \d+ more$/, '').split('\n')).toEqual(
      shown,
    );
  });

  it('sends a list that fits whole, with no marker invented for it', async () => {
    await discord(licenseLapse);

    expect(lockedOut()).toBe(
      'Ida Rhodes (ida@example.com) — read-only\n' +
        'Jean Bartik (jean@example.com) — deployer',
    );
  });

  // The property `capMessage` exists for, at the new cap: `JSON.stringify`
  // escapes a lone surrogate and leaves every paired one literal, so a
  // `\uD800`–`\uDFFF` escape in the serialized body is that defect and
  // nothing else.
  it('ends the cap on a whole character', async () => {
    await discord({
      ...licenseLapse,
      strandedMembers: members(300).map((member) => ({
        ...member,
        name: '🐳'.repeat(20),
      })),
    });

    expect(lockedOut().length).toBeLessThanOrEqual(DISCORD_FIELD_VALUE_LIMIT);
    expect(
      (fetchMock.mock.calls[0] as [string, { body: string }])[1].body,
    ).not.toMatch(/\\u[dD][89a-fA-F]/);
  });
});

/**
 * The cap's budget hands the body *"4096 minus the prose"*, and the prose
 * interpolates fields that were themselves unbounded — a project name, an
 * application name, an organization name, a server name, a cleanup summary, a
 * threshold alert. So a long enough name spent the whole budget and the message
 * went over the limit however hard the body was cut, and telegram refuses the
 * whole message rather than shortening it. The escaping rule widened that up to fivefold by
 * escaping before the cut (correctly): one `&` becomes five units of `&amp;`.
 *
 * The four events with no error body — app-deploy, docker-cleanup,
 * server-threshold, instance-restart — never called `withinTextLimit` at all,
 * so for those there was no cap of any kind: a build **success** for a project
 * with a long name was refused as readily as a build failure.
 *
 * Measured before the fix, with every field 5,000 `&` against a limit of 4,096:
 * app-deploy assembled **100,146** units, app-build-error 75,152,
 * database-backup 100,184, volume-backup 125,209, server-threshold 50,215,
 * license-lapse 50,121, docker-cleanup 25,091 and instance-backup 25,179 — and
 * the three error bodies were cut to **zero** on the way, so those messages
 * were both over the limit and missing the diagnostic they existed to carry.
 *
 * Two of the five fields the issue named are bounded at their source and are
 * cited rather than re-invented (`organization.dto.ts` `.max(255)`, and a
 * member's role at `.max(50)`); the rest are `text` columns behind a
 * `z.string().min(1)`. A source-character bound still cannot close the
 * arithmetic — five fields of 255 characters escape to 6,375 units — so
 * `escapedField`'s 512 is a **unit** bound on the escaped form, and it is
 * Cloudgate's number rather than telegram's.
 */
describe('escapedField, the interpolated prose that refused a whole message', () => {
  const TELEGRAM_TEXT_LIMIT = 4096;

  const telegram = (event: ChannelEvent) =>
    new TelegramChannelStrategy(fetchMock as never).send(
      { botToken: '123:ABC', chatId: '-10042', messageThreadId: null },
      event,
    );

  const text = (): string => jsonBody().text as string;

  const rawBody = (): string =>
    (fetchMock.mock.calls[0] as [string, { body: string }])[1].body;

  // The same probe the H-122 and cap blocks use, read off the wire:
  // `JSON.stringify` escapes a lone surrogate and leaves every paired one
  // literal, so a `\uD800`–`\uDFFF` escape in the serialized body is that
  // defect and nothing else.
  const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F]/;

  // The escaping rule, restated here because the cap now lands inside fields as
  // well as inside bodies: `<b>` and `<pre>` are the only tags this file
  // emits, and anything else telegram cannot parse gets the message refused.
  const EMITTED_TAGS = /<\/?(?:b|pre)>/g;
  const unparsable = (body: string): string[] => {
    const stripped = body.replace(EMITTED_TAGS, '');
    return [
      ...stripped.matchAll(
        /[<>]|&(?!lt;|gt;|amp;|quot;|#\d+;|#x[\da-fA-F]+;)/g,
      ),
    ].map((match) => stripped.slice(match.index, match.index + 16));
  };

  /**
   * 5,000 `&`, which escape to 25,000 units — six times the whole budget on
   * one field. `&` rather than a plain letter because it is the worst case
   * the escaping rule created and the one the arithmetic has to survive: a bound taken on
   * unescaped characters would let five of these through at 30,000 units.
   */
  const longField = '&'.repeat(5000);

  /** Every string an operator or an agent supplies, at that length. */
  const overlong: ChannelEvent[] = [
    {
      ...buildSuccess,
      projectName: longField,
      applicationName: longField,
      environmentName: longField,
      applicationType: longField,
    },
    {
      ...buildError,
      projectName: longField,
      applicationName: longField,
      applicationType: longField,
      errorMessage: longField,
    },
    {
      ...databaseBackupFailed,
      projectName: longField,
      applicationName: longField,
      databaseType: longField,
      databaseName: longField,
      errorMessage: longField,
    },
    {
      ...volumeBackupSucceeded,
      status: 'error',
      projectName: longField,
      applicationName: longField,
      volumeName: longField,
      serviceType: longField,
      backupSize: longField,
      errorMessage: longField,
    },
    { ...dockerCleanup, message: longField },
    { ...serverThreshold, serverName: longField, message: longField },
    {
      ...instanceBackup,
      status: 'error',
      backupSize: longField,
      errorMessage: longField,
    },
    {
      ...licenseLapse,
      organizationName: longField,
      message: longField,
      strandedMembers: [{ name: longField, email: longField, role: longField }],
    },
    instanceRestart,
    { type: 'test' },
  ];

  // The whole of `format`, not only the events that have a body: the property
  // is a property of the file, and an eleventh event that interpolates a field
  // without bounding it fails here rather than reaching a chat.
  it.each(overlong.map((event) => [event.type, event] as const))(
    '%s stays inside telegram 4096-character text limit with every field overlong',
    async (_type, event) => {
      await telegram(event);

      expect(text().length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    },
  );

  // Bounding a field cuts escaped text, so it inherits the hazard the escaping rule
  // documented for the body: a cut inside `&amp;` leaves `&am`, which telegram
  // refuses for the same reason a bare `<` is refused.
  it.each(overlong.map((event) => [event.type, event] as const))(
    '%s sends nothing telegram would refuse to parse when a field is cut',
    async (_type, event) => {
      await telegram(event);

      expect(unparsable(text())).toEqual([]);
    },
  );

  /**
   * The half of the budget question that is not the length: the body's budget is what the
   * prose leaves, so unbounded prose could take it to zero and drop the
   * diagnostic while *also* going over the limit. Bounding the fields puts a
   * floor under the remainder — measured at 2,414 units for app-build-error,
   * 1,872 for database-backup and 1,337 for volume-backup, the widest event at
   * five fields — and this asserts the floor rather than the arithmetic.
   */
  const errorSites: [string, ChannelEvent][] = [
    [
      'app-build-error',
      {
        ...buildError,
        projectName: longField,
        applicationName: longField,
        applicationType: longField,
        errorMessage: 'x'.repeat(5000),
      },
    ],
    [
      'database-backup',
      {
        ...databaseBackupFailed,
        projectName: longField,
        applicationName: longField,
        databaseType: longField,
        databaseName: longField,
        errorMessage: 'x'.repeat(5000),
      },
    ],
    [
      'volume-backup',
      {
        ...volumeBackupSucceeded,
        status: 'error',
        projectName: longField,
        applicationName: longField,
        volumeName: longField,
        serviceType: longField,
        backupSize: longField,
        errorMessage: 'x'.repeat(5000),
      },
    ],
  ];

  it.each(errorSites)(
    '%s still carries a diagnostic when every name around it is overlong',
    async (_site, event) => {
      await telegram(event);

      const body = /<pre>(x*)<\/pre>$/.exec(text());
      expect(body).not.toBeNull();
      // Not merely non-empty: the remainder has to be worth reading, and the
      // narrowest event's floor is over a thousand units.
      expect(body?.[1].length).toBeGreaterThan(1000);
    },
  );

  it('a license lapse with an overlong organization name still names who is locked out', async () => {
    await telegram({
      ...licenseLapse,
      organizationName: longField,
      strandedMembers: Array.from({ length: 300 }, (_, i) => ({
        name: `Member ${i}`,
        email: `member${i}@example.com`,
        role: 'read-only',
      })),
    });

    expect(text().length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    expect(text()).toContain('<b>Locked Out:</b> 300');
    // The list is the body and gets the budget the bounded prose leaves, so a
    // truncated list is still a list.
    expect(
      text().match(/• Member \d+ \(member\d+@example\.com\) — read-only/g)
        ?.length ?? 0,
    ).toBeGreaterThan(10);
  });

  // Nothing an operator would plausibly type is touched. 255 is the one bound
  // the tree really places on a name-shaped field (`organization.dto.ts`), so
  // a field at exactly that length is the case the number was chosen to keep.
  it('a name at the longest length the tree accepts arrives whole', async () => {
    const name = 'n'.repeat(255);

    await telegram({ ...buildSuccess, projectName: name });

    expect(text()).toContain(`<b>Project:</b> ${name}\n`);
  });

  /**
   * license-lapse's `message` is the one interpolated field that is Cloudgate's
   * own prose rather than operator input — `LAPSE_GUIDANCE` plus a count — and
   * it is bounded like the rest so the total is bounded, which means the
   * headroom needs a guard. Extending the guidance past 512 units fails here
   * instead of silently truncating the sentence that says why nobody was
   * migrated off their role.
   */
  it('the lapse guidance fits inside the field bound with room to spare', async () => {
    await telegram(licenseLapse);

    expect(text().endsWith(licenseLapse.message)).toBe(true);
    expect(licenseLapse.message.length).toBeLessThan(512);
  });

  /**
   * The property `capMessage` exists for, now that a second cap uses it. `🐳`
   * is U+1F433, two code units; where the field's boundary lands depends on
   * the field's own content, so both parities are sent and neither may leave
   * half a whale behind.
   */
  it.each([
    ['even offset', '🐳'.repeat(1000)],
    ['odd offset', `x${'🐳'.repeat(1000)}`],
  ])(
    'cuts a field at %s without splitting a character',
    async (_parity, name) => {
      await telegram({ ...buildSuccess, projectName: name });

      expect(rawBody()).not.toMatch(LONE_SURROGATE_ESCAPE);
      expect(text().length).toBeLessThanOrEqual(TELEGRAM_TEXT_LIMIT);
    },
  );
});

/**
 * The other half of the budget question: the same arithmetic applies to any channel
 * whose cap is taken on an assembled string rather than on one field, and
 * pushover is the one (1024 units, on `message`). It does **not** share the
 * defect, and this block is the evidence for that rather than an assertion of
 * it: pushover's cap is taken on the *whole* assembled message, so an unbounded
 * project name spends the tail of the message and not a body's budget. The
 * result is 1024 units by construction, and pushover receives something it can
 * deliver — the *detail* category, not its *delivery* one.
 *
 * Kept as a test so that moving pushover's cap onto a budgeted body, the shape
 * telegram had, fails here instead of quietly re-opening the budget bug one channel over.
 */
describe('pushover message, an assembled cap that overlong prose cannot breach', () => {
  const PUSHOVER_MESSAGE_LIMIT = 1024;

  const pushover = (event: ChannelEvent) =>
    new PushoverChannelStrategy(fetchMock as never).send(
      { userKey: 'U', apiToken: 'T', priority: 1, retry: null, expire: null },
      event,
    );

  const pushoverMessage = (): string => {
    const [, init] = fetchMock.mock.calls[0] as [
      string,
      { body: URLSearchParams },
    ];
    return init.body.get('message') ?? '';
  };

  const longField = 'n'.repeat(5000);

  const overlong: ChannelEvent[] = [
    {
      ...buildSuccess,
      projectName: longField,
      applicationName: longField,
      environmentName: longField,
      applicationType: longField,
    },
    {
      ...buildError,
      projectName: longField,
      applicationName: longField,
      applicationType: longField,
      errorMessage: longField,
    },
    {
      ...databaseBackupFailed,
      projectName: longField,
      applicationName: longField,
      databaseType: longField,
      databaseName: longField,
      errorMessage: longField,
    },
    {
      ...volumeBackupSucceeded,
      status: 'error',
      projectName: longField,
      applicationName: longField,
      volumeName: longField,
      serviceType: longField,
      backupSize: longField,
      errorMessage: longField,
    },
    { ...dockerCleanup, message: longField },
    { ...serverThreshold, serverName: longField, message: longField },
    {
      ...instanceBackup,
      status: 'error',
      backupSize: longField,
      errorMessage: longField,
    },
    {
      ...licenseLapse,
      organizationName: longField,
      message: longField,
      strandedMembers: [{ name: longField, email: longField, role: longField }],
    },
    instanceRestart,
    { type: 'test' },
  ];

  it.each(overlong.map((event) => [event.type, event] as const))(
    '%s stays inside the pushover 1024-character message limit with every field overlong',
    async (_type, event) => {
      await pushover(event);

      expect(pushoverMessage().length).toBeLessThanOrEqual(
        PUSHOVER_MESSAGE_LIMIT,
      );
    },
  );

  // The title is the other parameter with a documented limit (250), and no
  // input reaches it — a literal, or a literal plus a two-value metric union.
  it.each(overlong.map((event) => [event.type, event] as const))(
    '%s sends a title no input can lengthen',
    async (_type, event) => {
      await pushover(event);

      const [, init] = fetchMock.mock.calls[0] as [
        string,
        { body: URLSearchParams },
      ];
      expect((init.body.get('title') ?? '').length).toBeLessThanOrEqual(250);
    },
  );
});

/**
 * The greeting census gate. The probe's text was copy-pasted into eleven strategies
 * and the email template — twelve literals, so correcting the wording in one
 * place corrected nothing — and the accompanying title had three answers:
 * `Test Notification`, `Test Email`, and nothing at all.
 *
 * Two tests hold it at one copy, and they fail for different reasons on
 * purpose. The first drives every channel and asserts the constant reaches the
 * wire, which catches a channel that renders something else. The second reads
 * the module's own source and asserts the literal appears only where the
 * constant is declared, which catches the thirteenth copy — a new channel that
 * pastes the string instead of importing it renders the right text and would
 * pass the first test on its own.
 *
 * The table is checked against `notificationType.enumValues` below, so a new
 * channel that is not driven here fails rather than being quietly uncovered.
 */
const testEvent: ChannelEvent = { type: 'test' };
const smtpMock = { send: jest.fn() };
const resendSenderMock = { send: jest.fn() };

/**
 * Everything a channel put on the wire, as one searchable string: the URL,
 * the headers (ntfy carries its title in `X-Title`) and the body, which is
 * JSON on eight channels, a raw string on ntfy and form data on pushover.
 * Entries are read rather than `URLSearchParams.toString()`, which would
 * percent-encode the text out of recognition.
 */
const fetchWire = (): string => {
  const [url, init] = fetchMock.mock.calls[0] as [
    string,
    { headers?: Record<string, string>; body?: unknown },
  ];
  const { body } = init;
  const rendered =
    typeof body === 'string'
      ? body
      : body instanceof URLSearchParams
        ? [...body.entries()].map(([k, v]) => `${k}=${v}`).join('\n')
        : JSON.stringify(body);
  return [url, JSON.stringify(init.headers ?? {}), rendered].join('\n');
};

const senderWire = (sender: { send: jest.Mock }): string => {
  const [, subject, html] = sender.send.mock.calls[0] as [
    unknown,
    string,
    string,
  ];
  return `${subject}\n${html}`;
};

const probes: {
  channel: NotificationType;
  send: () => Promise<void>;
  wire: () => string;
  /** Whether this channel's payload has anywhere to put a title. */
  titled: boolean;
}[] = [
  {
    channel: 'slack',
    send: () =>
      new SlackChannelStrategy(fetchMock as never).send(
        {
          webhookUrl: 'https://hooks.slack.com/services/T/B/X',
          channel: '#ops',
        },
        testEvent,
      ),
    wire: fetchWire,
    titled: false,
  },
  {
    channel: 'telegram',
    send: () =>
      new TelegramChannelStrategy(fetchMock as never).send(
        { botToken: 't', chatId: 'c', messageThreadId: null },
        testEvent,
      ),
    wire: fetchWire,
    titled: false,
  },
  {
    channel: 'discord',
    send: () =>
      new DiscordChannelStrategy(fetchMock as never).send(
        { webhookUrl: 'https://discord.com/api/webhooks/X', decoration: true },
        testEvent,
      ),
    wire: fetchWire,
    titled: true,
  },
  {
    channel: 'email',
    send: () =>
      new EmailChannelStrategy(smtpMock as never).send(
        {
          smtpServer: 'smtp.example.com',
          smtpPort: 587,
          username: 'mailer',
          password: 'secret',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        testEvent,
      ),
    wire: () => senderWire(smtpMock),
    titled: true,
  },
  {
    channel: 'resend',
    send: () =>
      new ResendChannelStrategy(resendSenderMock as never).send(
        {
          apiKey: 're_x',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        testEvent,
      ),
    wire: () => senderWire(resendSenderMock),
    titled: true,
  },
  {
    channel: 'gotify',
    send: () =>
      new GotifyChannelStrategy(fetchMock as never).send(
        {
          serverUrl: 'https://gotify.example.com',
          appToken: 'g',
          priority: 5,
          decoration: false,
        },
        testEvent,
      ),
    wire: fetchWire,
    titled: true,
  },
  {
    channel: 'ntfy',
    send: () =>
      new NtfyChannelStrategy(fetchMock as never).send(
        {
          serverUrl: 'https://ntfy.sh',
          topic: 'cg-probe',
          accessToken: null,
          priority: 3,
        },
        testEvent,
      ),
    wire: fetchWire,
    titled: true,
  },
  {
    channel: 'mattermost',
    send: () =>
      new MattermostChannelStrategy(fetchMock as never).send(
        {
          webhookUrl: 'https://mm.example.com/hooks/X',
          channel: 'ops',
          username: null,
        },
        testEvent,
      ),
    wire: fetchWire,
    titled: false,
  },
  {
    channel: 'custom',
    send: () =>
      new CustomChannelStrategy(fetchMock as never).send(
        { endpoint: 'https://hook.example.com/', headers: null },
        testEvent,
      ),
    wire: fetchWire,
    titled: true,
  },
  {
    channel: 'lark',
    send: () =>
      new LarkChannelStrategy(fetchMock as never).send(
        { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/X' },
        testEvent,
      ),
    wire: fetchWire,
    titled: false,
  },
  {
    channel: 'pushover',
    send: () =>
      new PushoverChannelStrategy(fetchMock as never).send(
        {
          userKey: 'u',
          apiToken: 'a',
          priority: 0,
          retry: null,
          expire: null,
        },
        testEvent,
      ),
    wire: fetchWire,
    titled: true,
  },
  {
    channel: 'teams',
    send: () =>
      new TeamsChannelStrategy(fetchMock as never).send(
        { webhookUrl: 'https://outlook.office.com/webhook/X' },
        testEvent,
      ),
    wire: fetchWire,
    titled: true,
  },
];

describe('TEST_MESSAGE and TEST_TITLE, the one test probe', () => {
  beforeEach(() => {
    smtpMock.send.mockReset().mockResolvedValue(undefined);
    resendSenderMock.send.mockReset().mockResolvedValue(undefined);
  });

  /**
   * The wording, written out (§1.7) — and this is the assertion the rest of
   * this block rests on.
   *
   * Everything below compares what a channel sent against `TEST_MESSAGE`,
   * which is the constant compared to itself: it proves the twelve sites agree
   * with each other, which is the *census* half, and proves nothing at all
   * about what they agree on. Measured: with only those tests, restoring the
   * old `Hi, From Cloudgate 👋` keeps the whole suite green — the source scan
   * below skips the declaring file by design, so nothing else would catch it
   * either. The first acceptance criterion is *"punctuated as a greeting,
   * with no stray capital"*, and it is pinned here or nowhere.
   *
   * So the two literals are typed out rather than imported, which is the
   * point: an import would recompute the expectation the way the code does.
   * Do not "tidy" them into `TEST_MESSAGE`/`TEST_TITLE` — that deletes the
   * test while leaving it green.
   */
  it('reads as one greeting, with no stray capital', () => {
    expect(TEST_MESSAGE).toBe('Hi from Cloudgate 👋');
    expect(TEST_TITLE).toBe('Test Notification');
  });

  it('drives every channel the registry can dispatch to', () => {
    expect([...probes.map((probe) => probe.channel)].sort()).toEqual(
      [...notificationType.enumValues].sort(),
    );
  });

  it.each(probes.map((probe) => [probe.channel, probe] as const))(
    '%s renders the shared probe text',
    async (_channel, probe) => {
      await probe.send();

      expect(probe.wire()).toContain(TEST_MESSAGE);
    },
  );

  it.each(
    probes.filter((probe) => probe.titled).map((p) => [p.channel, p] as const),
  )('%s renders the shared probe title', async (_channel, probe) => {
    await probe.send();

    expect(probe.wire()).toContain(TEST_TITLE);
  });

  /**
   * The thirteenth-copy gate. `channel.strategy.ts` declares both constants and
   * is the only file allowed to hold either literal; everything else in
   * `src/notifications` has to import them.
   *
   * The old wording is scanned for too, and separately: it is not a substring
   * of the new one, so a file left behind on `Hi, From Cloudgate` would pass a
   * scan that only looked for the constant's absence.
   */
  it('holds each probe literal to the one file that declares it', () => {
    const root = join(__dirname, '../../src/notifications');
    const sources = readdirSync(root, { recursive: true })
      .map(String)
      .filter((name) => name.endsWith('.ts') || name.endsWith('.tsx'));

    const copies = sources.filter((name) => {
      if (name === join('channels', 'channel.strategy.ts')) return false;
      const source = readFileSync(join(root, name), 'utf8');
      return (
        source.includes(TEST_MESSAGE) ||
        source.includes(TEST_TITLE) ||
        source.includes('Hi, From Cloudgate')
      );
    });

    expect(copies).toEqual([]);
  });
});

/**
 * What a failed "Send a test" said depended on which channel had been
 * picked, and on the connection failure — the one an operator most needs named
 * — it said nothing at all.
 *
 * `fetch` rejects with a `TypeError` whose message is the bare `fetch failed`
 * however it failed; `getaddrinfo ENOTFOUND …` and `connect ECONNREFUSED …`
 * are on its `cause`, which nothing read. So a hostname to correct and a
 * service to start produced the identical *"Did not work. Fetch failed."*
 *
 * `NotificationsService.deliverTest` puts the message these throw into the 400
 * verbatim (`redactCredentials` aside, which changes nothing here — no
 * credential is in either sentence), so asserting on the thrown message is
 * asserting on the body the console renders.
 */
describe('channelFailure, on a delivery that named no cause', () => {
  const dnsFailure = (): Error =>
    new TypeError('fetch failed', {
      cause: Object.assign(
        new Error('getaddrinfo ENOTFOUND mattermost.invalid.example'),
        { code: 'ENOTFOUND' },
      ),
    });

  const refusedFailure = (): Error =>
    new TypeError('fetch failed', {
      cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9999'), {
        code: 'ECONNREFUSED',
      }),
    });

  const mattermost = async (rejection: Error): Promise<string> => {
    fetchMock.mockRejectedValue(rejection);
    try {
      await new MattermostChannelStrategy(fetchMock as never).send(
        {
          webhookUrl: 'https://mattermost.invalid.example/hooks/x',
          channel: null,
          username: null,
        },
        testEvent,
      );
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('the strategy resolved a rejected fetch');
  };

  it('tells a host that does not resolve from a port that refuses', async () => {
    const unresolved = await mattermost(dnsFailure());
    const refused = await mattermost(refusedFailure());

    expect(unresolved).not.toBe(refused);
    expect(unresolved).toContain('ENOTFOUND');
    expect(refused).toContain('ECONNREFUSED');
  });

  it('never answers with undici’s bare placeholder', async () => {
    for (const rejection of [dnsFailure(), refusedFailure()]) {
      const message = await mattermost(rejection);

      expect(message.toLowerCase()).not.toContain('fetch failed');
    }
  });

  /**
   * The same two rejections through the method that builds the 400 — the
   * suspected code the ticket names. Every strategy composes its sentence now, so
   * this is normally a pass-through; it walks the chain anyway, for a transport
   * that rejects somewhere no strategy wraps.
   */
  it('resolves the cause in the message deliverTest answers with', () => {
    const unresolved = deliveryFailureMessage(dnsFailure(), 'fallback');
    const refused = deliveryFailureMessage(refusedFailure(), 'fallback');

    expect(unresolved).toBe('getaddrinfo ENOTFOUND mattermost.invalid.example');
    expect(refused).toBe('connect ECONNREFUSED 127.0.0.1:9999');
    expect(unresolved).not.toBe(refused);
  });

  /**
   * The prefix census. Before this, six channels gave five answers: mattermost
   * and lark no prefix at all, teams and resend the prefix run into the reason
   * with no punctuation ("Failed to send Teams notification fetch failed."),
   * and only pushover's read as a sentence. Every channel is driven here, on
   * the path that had no prefix at all — a rejected transport — so a
   * thirteenth channel that invents its own wording fails.
   */
  /**
   * The twelve sentences, typed out (§1.7) rather than composed from
   * `CHANNEL_NAMES`. Composing them would recompute the expectation the way
   * the code does: a name mistyped in the table — `Mattermosst`, or `teams`
   * where the other brands are capitalised — would be read back out of the
   * same table and pass, which is the shape the double-prefix bug was filed about
   * in the first place. Typed out, the sentence an operator reads is in this file, and a
   * change to the table has to be argued for here too.
   *
   * The colon and the single space after it are the punctuation half of the
   * acceptance criterion, so they are inside the literals rather than asserted
   * separately.
   */
  const FAILURE_SENTENCES: Record<NotificationType, string> = {
    slack: 'Failed to send Slack notification: ',
    telegram: 'Failed to send Telegram notification: ',
    discord: 'Failed to send Discord notification: ',
    email: 'Failed to send email notification: ',
    resend: 'Failed to send Resend notification: ',
    gotify: 'Failed to send Gotify notification: ',
    ntfy: 'Failed to send ntfy notification: ',
    mattermost: 'Failed to send Mattermost notification: ',
    custom: 'Failed to send custom webhook notification: ',
    lark: 'Failed to send Lark notification: ',
    pushover: 'Failed to send Pushover notification: ',
    teams: 'Failed to send Teams notification: ',
  };

  it.each(probes.map((probe) => [probe.channel, probe] as const))(
    '%s says the one sentence, punctuated, on a rejected transport',
    async (channel, probe) => {
      fetchMock.mockRejectedValue(dnsFailure());
      smtpMock.send.mockReset().mockRejectedValue(dnsFailure());
      resendSenderMock.send.mockReset().mockRejectedValue(dnsFailure());

      await expect(probe.send()).rejects.toThrow(
        `${FAILURE_SENTENCES[channel]}getaddrinfo ENOTFOUND mattermost.invalid.example`,
      );
    },
  );

  /**
   * The two mail senders live in `src/mail/senders` — the mail module's, not
   * this one's — and they report the transport's failure and nothing else.
   * They used to flatten their own unpunctuated `Failed to send <x>
   * notification <reason>` into every rejection, which is where the
   * *"Failed to send Resend notification API key is invalid."* came from, and
   * `CHANNEL_PREFIX` stripped it back off. That strip was a second place that
   * had to know the sender's wording; it is gone, and what is pinned here is
   * that the strategy still composes exactly one sentence around Resend's own
   * words.
   */
  it("composes the one sentence around the mail sender's own words", async () => {
    resendSenderMock.send
      .mockReset()
      .mockRejectedValue(new Error('API key is invalid'));

    await expect(
      new ResendChannelStrategy(resendSenderMock as never).send(
        {
          apiKey: 're_x',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        testEvent,
      ),
    ).rejects.toThrow('Failed to send Resend notification: API key is invalid');
  });

  /**
   * The strip that is still load-bearing: `channelFailure` from a strategy's
   * `catch` usually receives what its own non-ok path threw. Both paths, one
   * sentence.
   */
  it('says the sentence once when the strategy already composed it', async () => {
    resendSenderMock.send
      .mockReset()
      .mockRejectedValue(
        new Error('Failed to send Resend notification: API key is invalid'),
      );

    await expect(
      new ResendChannelStrategy(resendSenderMock as never).send(
        {
          apiKey: 're_x',
          fromAddress: 'noreply@example.com',
          toAddresses: ['ops@example.com'],
        },
        testEvent,
      ),
    ).rejects.toThrow('Failed to send Resend notification: API key is invalid');
  });

  it('keeps a sentence that already names its cause, and the fallback when nothing does', () => {
    expect(
      deliveryFailureMessage(
        new Error('Failed to send Resend notification: API key is invalid'),
        'fallback',
      ),
    ).toBe('Failed to send Resend notification: API key is invalid');
    expect(deliveryFailureMessage(new TypeError('fetch failed'), 'f')).toBe(
      'fetch failed',
    );
    expect(deliveryFailureMessage(undefined, 'Error testing it')).toBe(
      'Error testing it',
    );
  });
});
