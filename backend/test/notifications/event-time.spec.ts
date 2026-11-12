import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { format } from 'date-fns';
import { notificationType } from '../../src/db/schema';
import type { NotificationType } from '../../src/db/schema';
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
import type { NotificationEvent } from '../../src/notifications/events/notification-event';
import { formatEventTime } from '../../src/notifications/events/event-time';

/**
 * Every channel printed its Time/Date with a bare `toLocaleString()` (or
 * `date-fns`' `format`, the same thing spelled differently) — the server's
 * zone, the server's locale, and no zone label — so a UTC box read hours off
 * for every operator who was not in UTC, with nothing to say so.
 *
 * The property is pinned from both ends. The render census drives every
 * channel with every event and requires each wire to carry a time the reader
 * can place — the UTC-labelled form, or Discord's client-rendered `<t:…>` —
 * and, where the event has a time of its own, that time rather than the moment
 * the message was built; and it requires the wire to carry none of the bare
 * renderings of the same instant in whatever zone this process runs in. The
 * source scan is the other end: it refuses the bare call itself in
 * `src/notifications`, so a new channel cannot bring it back in a branch this
 * census does not happen to render.
 *
 * **Not "render it under two zones and compare", which was the first shape
 * and is measured not to work here.** Assigning `process.env.TZ` moves Node's
 * zone only on the real `process.env`, and a jest worker hands each suite a
 * copy: `new Date(x).toLocaleString()` read identically under `Etc/UTC` and
 * `Pacific/Kiritimati` inside this file, so a two-zone comparison would pass
 * for a channel still on the bare call. The zone-independence is instead a
 * property of {@link formatEventTime}, which never asks for a local field.
 */

const pinnedNow = new Date('2026-07-24T10:30:00.000Z');
const nowLabel = '2026-07-24 10:30:00 UTC';
const sampledAt = '2026-07-24T09:00:00.000Z';
const validUntil = '2026-08-01T00:00:00.000Z';

const events: NotificationEvent[] = [
  {
    type: 'app-deploy',
    projectName: 'shop',
    applicationName: 'storefront',
    applicationType: 'application',
    environmentName: 'production',
    buildLink: 'https://cloudgate.example.com/x',
    domains: [{ host: 'shop.example.com', https: true }],
  },
  {
    type: 'app-build-error',
    projectName: 'shop',
    applicationName: 'storefront',
    applicationType: 'application',
    errorMessage: 'npm exited 1',
    buildLink: 'https://cloudgate.example.com/x',
  },
  {
    type: 'database-backup',
    projectName: 'shop',
    applicationName: 'orders-db',
    databaseType: 'postgres',
    status: 'error',
    databaseName: 'orders',
    errorMessage: 'pg_dump: connection refused',
  },
  {
    type: 'volume-backup',
    projectName: 'shop',
    applicationName: 'storefront',
    volumeName: 'data',
    serviceType: 'application',
    status: 'success',
    backupSize: '42 MB',
  },
  { type: 'docker-cleanup', message: 'Removed 5 images' },
  {
    type: 'server-threshold',
    serverName: 'Remote',
    metric: 'CPU',
    value: 92.5,
    threshold: 80,
    message: 'CPU usage high',
    timestamp: sampledAt,
  },
  { type: 'instance-backup', status: 'success', backupSize: '120 MB' },
  { type: 'instance-restart' },
  {
    type: 'license-lapse',
    organizationId: 'org_1',
    organizationName: 'Acme',
    validUntil,
    stopped: ['SSO sign-in'],
    strandedMembers: [
      { name: 'Ida Rhodes', email: 'ida@example.com', role: 'read-only' },
    ],
    message: 'Activate a license.',
  },
];

const fetchMock = jest.fn();
const smtpMock = { send: jest.fn() };
const resendMock = { send: jest.fn() };

/** The URL, headers and body of the one request a fetch channel made. */
const fetchWire = (): string | null => {
  if (fetchMock.mock.calls.length === 0) return null;
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

const senderWire = (sender: { send: jest.Mock }): string | null => {
  if (sender.send.mock.calls.length === 0) return null;
  const [, subject, html] = sender.send.mock.calls[0] as [
    unknown,
    string,
    string,
  ];
  return `${subject}\n${html}`;
};

const channels: Record<
  NotificationType,
  (event: NotificationEvent) => Promise<string | null>
> = {
  slack: async (event) => {
    await new SlackChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://hooks.slack.com/x', channel: '#ops' },
      event,
    );
    return fetchWire();
  },
  telegram: async (event) => {
    await new TelegramChannelStrategy(fetchMock as never).send(
      { botToken: '1:A', chatId: '-1', messageThreadId: null },
      event,
    );
    return fetchWire();
  },
  discord: async (event) => {
    await new DiscordChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://discord.com/api/webhooks/1/X', decoration: true },
      event,
    );
    return fetchWire();
  },
  email: async (event) => {
    await new EmailChannelStrategy(smtpMock as never).send(
      {
        smtpServer: 'smtp.example.com',
        smtpPort: 587,
        username: 'mailer',
        password: 'secret',
        fromAddress: 'noreply@example.com',
        toAddresses: ['ops@example.com'],
      },
      event,
    );
    return senderWire(smtpMock);
  },
  resend: async (event) => {
    await new ResendChannelStrategy(resendMock as never).send(
      { apiKey: 're_x', fromAddress: 'a@b.c', toAddresses: ['ops@b.c'] },
      event,
    );
    return senderWire(resendMock);
  },
  gotify: async (event) => {
    await new GotifyChannelStrategy(fetchMock as never).send(
      {
        serverUrl: 'https://gotify.example.com',
        appToken: 'g',
        priority: 5,
        decoration: true,
      },
      event,
    );
    return fetchWire();
  },
  ntfy: async (event) => {
    await new NtfyChannelStrategy(fetchMock as never).send(
      {
        serverUrl: 'https://ntfy.sh',
        topic: 'alerts',
        accessToken: null,
        priority: 3,
      },
      event,
    );
    return fetchWire();
  },
  mattermost: async (event) => {
    await new MattermostChannelStrategy(fetchMock as never).send(
      {
        webhookUrl: 'https://mm.example.com/hooks/X',
        channel: 'ops',
        username: null,
      },
      event,
    );
    return fetchWire();
  },
  custom: async (event) => {
    await new CustomChannelStrategy(fetchMock as never).send(
      { endpoint: 'https://hook.example.com/', headers: null },
      event,
    );
    return fetchWire();
  },
  lark: async (event) => {
    await new LarkChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://open.larksuite.com/bot/v2/hook/X' },
      event,
    );
    return fetchWire();
  },
  pushover: async (event) => {
    await new PushoverChannelStrategy(fetchMock as never).send(
      {
        userKey: 'u',
        apiToken: 'a',
        priority: 0,
        retry: null,
        expire: null,
      },
      event,
    );
    return fetchWire();
  },
  teams: async (event) => {
    await new TeamsChannelStrategy(fetchMock as never).send(
      { webhookUrl: 'https://outlook.office.com/webhook/X' },
      event,
    );
    return fetchWire();
  },
};

const render = async (
  channel: NotificationType,
  event: NotificationEvent,
): Promise<string | null> => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
  smtpMock.send.mockReset().mockResolvedValue(undefined);
  resendMock.send.mockReset().mockResolvedValue(undefined);
  return channels[channel](event);
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
});

afterEach(() => {
  jest.useRealTimers();
});

describe('formatEventTime', () => {
  it('prints the instant in UTC and says so', () => {
    expect(formatEventTime(new Date('2026-09-15T19:23:12.425Z'))).toBe(
      '2026-09-15 19:23:12 UTC',
    );
    expect(formatEventTime('2026-09-15T19:23:12.425Z')).toBe(
      '2026-09-15 19:23:12 UTC',
    );
  });

  it('asks the Date for no local field, so the server zone cannot reach it', () => {
    const local = jest.spyOn(Date.prototype, 'getHours');
    const locale = jest.spyOn(Date.prototype, 'toLocaleString');
    formatEventTime(new Date('2026-09-15T19:23:12.425Z'));
    expect(local).not.toHaveBeenCalled();
    expect(locale).not.toHaveBeenCalled();
    local.mockRestore();
    locale.mockRestore();
  });

  it('says it does not know rather than throwing on a value that is not a date', () => {
    expect(formatEventTime('not a date')).toBe('unknown time');
  });
});

describe("formatEventTime, on every channel's wire", () => {
  it('drives every channel the registry can dispatch to', () => {
    expect(Object.keys(channels).sort()).toEqual(
      [...notificationType.enumValues].sort(),
    );
  });

  const cases = (Object.keys(channels) as NotificationType[]).flatMap(
    (channel) => events.map((event) => [channel, event.type, event] as const),
  );

  it.each(cases)(
    '%s / %s prints a zoned time, and no bare local one',
    async (channel, _type, event) => {
      const wire = await render(channel, event);
      // A channel with no format for an event (gotify + server-threshold)
      // sends nothing at all.
      if (wire === null) return;

      const own =
        event.type === 'server-threshold'
          ? event.timestamp
          : event.type === 'license-lapse'
            ? event.validUntil
            : null;
      if (channel === 'discord') {
        const unix = Math.trunc(Number(new Date(own ?? pinnedNow)) / 1000);
        expect(wire).toContain(`<t:${unix}:`);
      } else if (own && channel === 'custom') {
        // The machine-facing channel carries the event's own time as the
        // ISO-8601 instant it arrived as (`validUntil`, `timestamp`).
        // Its human-readable `date` is the event's time where the event has
        // one to give (a threshold sample) and the send time otherwise.
        expect(wire).toContain(own);
        expect(wire).toContain(
          event.type === 'server-threshold' ? formatEventTime(own) : nowLabel,
        );
      } else if (own) {
        expect(wire).toContain(formatEventTime(own));
      } else {
        expect(wire).toContain(nowLabel);
      }
      for (const at of [pinnedNow, new Date(sampledAt), new Date(validUntil)]) {
        for (const bare of [
          at.toLocaleString(),
          format(at, 'PP'),
          format(at, 'pp'),
        ]) {
          expect(wire).not.toContain(bare);
        }
      }
    },
  );
});

describe('formatEventTime, the only time formatter in src/notifications', () => {
  /**
   * The census gate the ticket asked for. `toLocaleString()` and its two
   * siblings, and `date-fns`' `format`, all print in the server's zone with no
   * label; `event-time.ts` is the one place a human-readable time is made, and
   * it uses neither. Comments are scanned too, deliberately: a docblock that
   * names the call it replaced (as `event-time.ts`'s does) is exempt by being
   * in that file, and nowhere else has a reason to spell it.
   */
  it('appear nowhere outside the one formatter', () => {
    const root = join(__dirname, '../../src/notifications');
    const offenders = readdirSync(root, { recursive: true })
      .map(String)
      .filter((name) => /\.tsx?$/.test(name))
      .filter((name) => name !== join('events', 'event-time.ts'))
      .flatMap((name) =>
        readFileSync(join(root, name), 'utf8')
          .split('\n')
          .map((line, index) => ({ name, line, index }))
          .filter(
            ({ line }) =>
              /\.toLocale(Date|Time)?String\(/.test(line) ||
              /from 'date-fns'/.test(line),
          )
          .map(({ name, index }) => `${name}:${index + 1}`),
      );

    expect(offenders).toEqual([]);
  });
});
