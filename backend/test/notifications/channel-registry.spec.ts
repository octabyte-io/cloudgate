import { BadRequestException } from '@nestjs/common';
import { NotificationChannelRegistry } from '../../src/notifications/channels/channel-registry';
import {
  OUTBOUND_ADDRESS_REFUSED_CODE,
  OutboundAddressGuard,
} from '../../src/outbound/outbound-address-guard';
import type { AddressResolver } from '../../src/outbound/outbound-address';
import { selfHostedOwnAddresses } from '../outbound/self-hosted-own-addresses';

// The transports are the system boundary: a mocked fetch and SMTP sender
// record what would have left the platform host, and the guard between them
// and the channel is the real one, over a resolver answering from a table.

const INSTANCE_ORG = 'org_instance';
const CUSTOMER_ORG = 'org_customer';

const RECORDS: Record<string, string[]> = {
  'hooks.example.com': ['93.184.216.34'],
  'smtp.example.com': ['93.184.216.35'],
  'mail.internal.example.com': ['10.0.0.25'],
};
const resolve: AddressResolver = (host) => {
  const found = RECORDS[host];
  if (!found) {
    return Promise.reject(
      Object.assign(new Error('nope'), { code: 'ENOTFOUND' }),
    );
  }
  return Promise.resolve(found);
};

function registryWith() {
  const fetch = jest.fn(() => Promise.resolve(new Response('ok')));
  const smtp = {
    send: jest.fn<Promise<void>, unknown[]>(() => Promise.resolve()),
  };
  const guard = new OutboundAddressGuard(
    resolve,
    {
      instanceOrganizationId: () => Promise.resolve(INSTANCE_ORG),
    } as never,
    {} as never,
    selfHostedOwnAddresses,
  );
  const registry = new NotificationChannelRegistry(
    fetch as never,
    guard,
    smtp as never,
    { send: jest.fn() } as never,
  );
  return { registry, fetch, smtp };
}

const EMAIL = {
  smtpPort: 587,
  username: 'alerts',
  password: 'secret',
  fromAddress: 'alerts@example.com',
  toAddresses: ['ops@example.com'],
};

async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return error.getResponse() as { code: string; field: string };
  }
  throw new Error('expected a refusal, and the channel delivered');
}

describe("NotificationChannelRegistry, on where a channel's delivery may be dialled", () => {
  it.each([
    [
      'slack',
      { webhookUrl: 'http://169.254.169.254/latest/meta-data/' },
      'webhookUrl',
    ],
    [
      'discord',
      { webhookUrl: 'http://127.0.0.1:2375/containers/json' },
      'webhookUrl',
    ],
    ['mattermost', { webhookUrl: 'http://10.0.0.4/hooks/x' }, 'webhookUrl'],
    ['teams', { webhookUrl: 'http://192.168.1.1/' }, 'webhookUrl'],
    ['lark', { webhookUrl: 'http://[::1]/' }, 'webhookUrl'],
    [
      'gotify',
      { serverUrl: 'http://127.0.0.1:8080', appToken: 't', priority: 5 },
      'serverUrl',
    ],
    [
      'ntfy',
      { serverUrl: 'http://172.17.0.1', topic: 't', priority: 3 },
      'serverUrl',
    ],
    [
      'custom',
      {
        endpoint: 'http://169.254.169.254/',
        headers: { 'Metadata-Flavor': 'Google' },
      },
      'endpoint',
    ],
  ] as const)(
    "refuses a customer's %s channel aimed inside, naming the field, and sends nothing",
    async (type, connection, field) => {
      const { registry, fetch } = registryWith();

      const refusal = await refusalOf(
        registry
          .get(type, CUSTOMER_ORG)
          .send(connection as never, { type: 'test' }),
      );

      expect(refusal).toMatchObject({
        code: OUTBOUND_ADDRESS_REFUSED_CODE,
        field,
      });
      // Nothing left the platform host on the way to being refused.
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("delivers a customer's webhook to a public host", async () => {
    const { registry, fetch } = registryWith();

    await registry
      .get('slack', CUSTOMER_ORG)
      .send({ webhookUrl: 'https://hooks.example.com/T/B/x' } as never, {
        type: 'test',
      });

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("delivers the instance organization's webhook to an internal host", async () => {
    const { registry, fetch } = registryWith();

    await registry
      .get('custom', INSTANCE_ORG)
      .send({ endpoint: 'http://10.0.0.4:9000/alerts' } as never, {
        type: 'test',
      });

    expect(fetch).toHaveBeenCalledWith(
      'http://10.0.0.4:9000/alerts',
      expect.not.objectContaining({ dispatcher: expect.anything() as unknown }),
    );
  });

  it("refuses a customer's SMTP host that resolves to a private range, naming smtpServer", async () => {
    const { registry, smtp } = registryWith();

    const refusal = await refusalOf(
      registry
        .get('email', CUSTOMER_ORG)
        .send({ ...EMAIL, smtpServer: 'mail.internal.example.com' } as never, {
          type: 'test',
        }),
    );

    expect(refusal).toMatchObject({
      code: OUTBOUND_ADDRESS_REFUSED_CODE,
      field: 'smtpServer',
    });
    expect(smtp.send).not.toHaveBeenCalled();
  });

  it("sends a customer's mail to the SMTP address it checked, presenting the name for TLS", async () => {
    const { registry, smtp } = registryWith();

    await registry
      .get('email', CUSTOMER_ORG)
      .send({ ...EMAIL, smtpServer: 'smtp.example.com' } as never, {
        type: 'test',
      });

    // Only the connection is this spec's concern; the subject, body and any
    // inline image after it are the email strategy's.
    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(smtp.send.mock.calls[0][0]).toMatchObject({
      smtpServer: '93.184.216.35',
      servername: 'smtp.example.com',
    });
  });

  it("sends the instance organization's mail to its internal SMTP host as typed", async () => {
    const { registry, smtp } = registryWith();

    await registry
      .get('email', INSTANCE_ORG)
      .send({ ...EMAIL, smtpServer: 'mail.internal.example.com' } as never, {
        type: 'test',
      });

    expect(smtp.send).toHaveBeenCalledTimes(1);
    expect(smtp.send.mock.calls[0][0]).toMatchObject({
      smtpServer: 'mail.internal.example.com',
    });
  });
});
