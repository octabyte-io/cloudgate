import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { DeploymentNotification } from '../../src/deployment-engine/ports/deployment-notifier';
import { CustomChannelStrategy } from '../../src/notifications/channels/custom.strategy';
import { TelegramChannelStrategy } from '../../src/notifications/channels/telegram.strategy';
import { DeploymentNotifierAdapter } from '../../src/notifications/deployment-notifier.adapter';
import type { NotificationDispatcherService } from '../../src/notifications/dispatcher.service';
import type { AppDeployEvent } from '../../src/notifications/events/notification-event';
import type { InstanceUrlService } from '../../src/settings/instance-url.service';

/**
 * **The domains a deploy answers on are actually sent.**
 *
 * `AppDeployEvent.domains` was declared, and two channels read it — the custom
 * webhook's `domains` string and telegram's domain buttons, which its own
 * picker card advertises as *"buttons to the domains it deployed"*. **No
 * producer ever set it.** So the field was not empty in some case, it was
 * empty in every case, on every channel, for every install: an Application
 * with a live domain delivered `"domains": ""` and telegram could not draw a
 * button it promised.
 *
 * **Why the channel suite was green the whole time, and why this file is a
 * different test rather than another case there.** `channel-strategies.spec.ts`
 * already asserts both renderings — the joined host string and the chunked
 * buttons — against a fixture that hands the strategy three domains. The
 * fixture was right and the product was wrong, because nothing in between was
 * under test. Here the event is not written by hand: it is the one
 * `DeploymentNotifierAdapter` built, and the strategies are driven with *that*.
 * A producer that stops populating the field fails at the channel, which is
 * where an operator would have noticed it.
 *
 * The queries are asserted as rendered SQL rather than through a stub that
 * answers whatever it is asked, because "the right rows" is the claim: an
 * Application's domains hang off `application_id`, a Compose stack's off
 * `compose_id`, and a compose row naming no service is dropped — it is never
 * injected as a label, so it answers on nothing and promising it would be a
 * button to a 404.
 */

const dialect = new PgDialect();
const rendered = (clause: SQL | undefined) =>
  clause ? dialect.sqlToQuery(clause) : undefined;

const notification: DeploymentNotification = {
  projectName: 'ui-main',
  applicationName: 'ui-whoami',
  applicationType: 'application',
  environmentName: 'production',
  organizationId: 'org-1',
  projectId: 'xPGnIItsFHEKBAQuzp_VS',
  environmentId: 'gvPjILtTCqwlZ-dIfwa_e',
  serviceId: 'Ms5cBf9qWg5K9ptAFt--7',
};

type DomainRow = { host: string; https: boolean };

interface Asked {
  where?: SQL;
  orderBy?: SQL;
}

const makeDb = (rows: DomainRow[], asked: Asked) =>
  ({
    select: () => ({
      from: () => ({
        where: (clause: SQL) => {
          asked.where = clause;
          return {
            orderBy: (order: SQL) => {
              asked.orderBy = order;
              return Promise.resolve(rows);
            },
          };
        },
      }),
    }),
  }) as unknown as DrizzleDB;

/** The event the adapter dispatched for a deploy, and what it asked the db. */
async function deployEvent(
  rows: DomainRow[],
  overrides: Partial<DeploymentNotification> = {},
): Promise<{ event: AppDeployEvent; asked: Asked }> {
  const asked: Asked = {};
  const dispatch = jest.fn().mockResolvedValue(undefined);
  const notifier = new DeploymentNotifierAdapter(
    makeDb(rows, asked),
    { dispatch } as unknown as NotificationDispatcherService,
    // No console domain, no server IP: the link is omitted and this file is
    // about the other field. Another spec owns the link.
    {
      getInstanceUrl: () => Promise.resolve(null),
    } as unknown as InstanceUrlService,
  );

  await notifier.buildSuccess({ ...notification, ...overrides });
  const [, event] = dispatch.mock.calls[0] as [string, AppDeployEvent];
  return { event, asked };
}

const fetchMock = jest.fn();
const jsonBody = (): Record<string, unknown> => {
  const [, init] = fetchMock.mock.calls[0] as [string, { body: string }];
  return JSON.parse(init.body) as Record<string, unknown>;
};

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue({ ok: true, statusText: 'OK' });
});

describe('DeploymentNotifierAdapter.buildSuccess, on the domains it carries', () => {
  it("carries the Application's domains, and both channels that read them render the hosts", async () => {
    const { event, asked } = await deployEvent([
      { host: 'whoami.203.0.113.42.sslip.io', https: false },
      { host: 'shop.example.com', https: true },
    ]);

    // The rows asked for are the Application's own, ordered so two channels
    // and two deploys of one Application agree on the order.
    expect(rendered(asked.where)).toEqual({
      sql: '"domain"."application_id" = $1',
      params: [notification.serviceId],
      typings: ['none'],
    });
    expect(rendered(asked.orderBy)?.sql).toBe('"domain"."host" asc');

    expect(event.domains).toEqual([
      { host: 'whoami.203.0.113.42.sslip.io', https: false },
      { host: 'shop.example.com', https: true },
    ]);

    await new CustomChannelStrategy(fetchMock as never).send(
      { endpoint: 'https://internal.example.com/hook', headers: {} },
      event,
    );
    // `"domains": ""` is what the ticket was filed on. This is the delivered
    // body for an Application that has a domain.
    expect(jsonBody().domains).toBe(
      'whoami.203.0.113.42.sslip.io, shop.example.com',
    );

    fetchMock.mockClear();
    await new TelegramChannelStrategy(fetchMock as never).send(
      { botToken: '123:ABC', chatId: '-10042' },
      event,
    );
    expect(jsonBody().reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: 'whoami.203.0.113.42.sslip.io',
            url: 'http://whoami.203.0.113.42.sslip.io',
          },
          { text: 'shop.example.com', url: 'https://shop.example.com' },
        ],
      ],
    });
  });

  it("asks for a Compose stack's domains, and skips one that routes into no service", async () => {
    const { asked } = await deployEvent([], {
      applicationType: 'compose',
      serviceId: 'stack-1',
    });

    expect(rendered(asked.where)).toEqual({
      sql: '("domain"."compose_id" = $1 and "domain"."service_name" is not null)',
      params: ['stack-1'],
      typings: ['none'],
    });
  });

  it('carries an empty list for a Service with no domains, and neither channel renders a stray separator', async () => {
    const { event } = await deployEvent([]);

    expect(event.domains).toEqual([]);

    await new CustomChannelStrategy(fetchMock as never).send(
      { endpoint: 'https://internal.example.com/hook', headers: {} },
      event,
    );
    expect(jsonBody().domains).toBe('');

    fetchMock.mockClear();
    await new TelegramChannelStrategy(fetchMock as never).send(
      { botToken: '123:ABC', chatId: '-10042' },
      event,
    );
    // No buildLink either here, so the keyboard is empty rather than carrying
    // an empty row — a row of no buttons is what telegram renders as a gap.
    expect(jsonBody().reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('asks for no domains at all for a service type with no scope of its own', async () => {
    const { event, asked } = await deployEvent([{ host: 'x', https: true }], {
      applicationType: 'database',
    });

    expect(asked.where).toBeUndefined();
    expect(event.domains).toEqual([]);
  });
});
