import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BadRequestException } from '@nestjs/common';
import {
  guardedConnector,
  OUTBOUND_ADDRESS_REFUSED_CODE,
  OutboundAddressGuard,
} from '../../src/outbound/outbound-address-guard';
import type { AddressResolver } from '../../src/outbound/outbound-address';
import { selfHostedOwnAddresses } from './self-hosted-own-addresses';

const INSTANCE_ORG = 'org_instance';
const CUSTOMER_ORG = 'org_customer';

/** A resolver that answers from a table, so no test reaches real DNS. */
function resolverOf(table: Record<string, string[]>): AddressResolver & {
  calls: string[];
} {
  const calls: string[] = [];
  const resolve = ((host: string) => {
    calls.push(host);
    const found = table[host];
    if (!found) {
      return Promise.reject(
        Object.assign(new Error('nope'), { code: 'ENOTFOUND' }),
      );
    }
    return Promise.resolve(found);
  }) as AddressResolver & { calls: string[] };
  resolve.calls = calls;
  return resolve;
}

function guardWith(resolve: AddressResolver): OutboundAddressGuard {
  const permissions = {
    instanceOrganizationId: () => Promise.resolve(INSTANCE_ORG),
  };
  return new OutboundAddressGuard(
    resolve,
    permissions as never,
    {} as never,
    selfHostedOwnAddresses,
  );
}

/** The refusal's body, or a failure naming what was thrown instead. */
async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    return error.getResponse() as {
      message: string;
      code: string;
      field: string;
    };
  }
  throw new Error('expected a refusal, and the dial was allowed');
}

describe('OutboundAddressGuard.addressToDial, on where the platform host may be pointed', () => {
  const resolve = resolverOf({
    'hooks.example.com': ['93.184.216.34'],
    'rebound.example.com': ['93.184.216.34', '10.0.0.5'],
    'metadata.example.com': ['169.254.169.254'],
    'empty.example.com': [],
  });
  const guard = guardWith(resolve);
  const customer = (field: string) => ({
    place: { organizationId: CUSTOMER_ORG },
    field,
  });

  it.each([
    ['127.0.0.1'],
    ['10.1.2.3'],
    ['192.168.1.10'],
    ['169.254.169.254'],
    ['::1'],
    ['[::ffff:7f00:1]'],
  ])("refuses a customer's literal %s, naming the field", async (host) => {
    const refusal = await refusalOf(
      guard.addressToDial(host, customer('webhookUrl')),
    );

    expect(refusal.code).toBe(OUTBOUND_ADDRESS_REFUSED_CODE);
    expect(refusal.field).toBe('webhookUrl');
    expect(refusal.message).toMatch(/^webhookUrl /);
  });

  it.each([
    ['metadata.example.com'],
    ['rebound.example.com'],
    ['empty.example.com'],
    ['unknown.example.com'],
  ])(
    "refuses a customer's name %s that does not resolve only to public addresses",
    async (host) => {
      const refusal = await refusalOf(
        guard.addressToDial(host, customer('smtpServer')),
      );

      expect(refusal.field).toBe('smtpServer');
    },
  );

  it("returns the checked public address for a customer's public name", async () => {
    await expect(
      guard.addressToDial('hooks.example.com', customer('webhookUrl')),
    ).resolves.toBe('93.184.216.34');
  });

  it('returns a public literal as it is', async () => {
    await expect(
      guard.addressToDial('93.184.216.34', customer('webhookUrl')),
    ).resolves.toBe('93.184.216.34');
  });

  it('lets the instance organization dial an internal address, without resolving it', async () => {
    resolve.calls.length = 0;
    await expect(
      guard.addressToDial('gitea.internal', {
        place: { organizationId: INSTANCE_ORG },
        field: 'giteaInternalUrl',
      }),
    ).resolves.toBe('gitea.internal');
    await expect(
      guard.addressToDial('::1', {
        place: { organizationId: INSTANCE_ORG },
        field: 'webhookUrl',
      }),
    ).resolves.toBe('::1');

    // Nothing was resolved on the way to being let through.
    expect(resolve.calls).toEqual([]);
  });
});

describe('OutboundAddressGuard.fetchFor, on a fetch that dials only the address it checked', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      response.end(`reached ${request.headers.host}`);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((done) => server.close(done));
  });

  it("refuses a customer's loopback URL with the field, and never connects", async () => {
    let connected = false;
    server.once('connection', () => {
      connected = true;
    });
    const guard = guardWith(resolverOf({}));
    const guarded = guard.fetchFor(fetch, {
      place: { organizationId: CUSTOMER_ORG },
      field: 'endpoint',
    });

    const refusal = await refusalOf(guarded(`http://127.0.0.1:${port}/hook`));

    expect(refusal.field).toBe('endpoint');
    // Nothing reached the internal listener on the way to being refused.
    expect(connected).toBe(false);
  });

  it('refuses a name that resolves to loopback, resolving it once', async () => {
    const resolve = resolverOf({ 'internal.example.com': ['127.0.0.1'] });
    const guarded = guardWith(resolve).fetchFor(fetch, {
      place: { organizationId: CUSTOMER_ORG },
      field: 'serverUrl',
    });

    const refusal = await refusalOf(
      guarded(`http://internal.example.com:${port}/message`),
    );

    expect(refusal.field).toBe('serverUrl');
    expect(resolve.calls).toEqual(['internal.example.com']);
  });

  it("lets the instance organization's fetch reach the internal listener", async () => {
    const guarded = guardWith(resolverOf({})).fetchFor(fetch, {
      place: { organizationId: INSTANCE_ORG },
      field: 'endpoint',
    });

    const response = await guarded(`http://127.0.0.1:${port}/hook`);

    expect(await response.text()).toBe(`reached 127.0.0.1:${port}`);
  });

  it('passes the request through to the transport it wraps', async () => {
    const base = jest.fn(() => Promise.resolve(new Response('ok')));
    const resolve = resolverOf({ 'hooks.example.com': ['93.184.216.34'] });
    const guarded = guardWith(resolve).fetchFor(base as never, {
      place: { organizationId: CUSTOMER_ORG },
      field: 'webhookUrl',
    });

    await guarded('https://hooks.example.com/x', { method: 'POST' });

    expect(base).toHaveBeenCalledWith(
      'https://hooks.example.com/x',
      expect.objectContaining({
        method: 'POST',
        dispatcher: expect.anything() as unknown,
      }),
    );
  });
});

describe('guardedConnector, on the connection a guarded fetch opens', () => {
  type Options = Parameters<ReturnType<typeof guardedConnector>>[0];
  const options = (hostname: string): Options => ({
    hostname,
    host: hostname,
    protocol: 'https:',
    port: '443',
  });

  /** Runs the connector once, answering what it handed the base connector. */
  function connectThrough(resolve: AddressResolver, hostname: string) {
    const base = jest.fn(
      (_options: Options, callback: (error: null, socket: never) => void) =>
        callback(null, {} as never),
    );
    const connect = guardedConnector(resolve, base as never);
    return new Promise<{ error: Error | null; dialled: Options | null }>(
      (done) =>
        connect(options(hostname), (...[error]) =>
          done({
            error,
            dialled: base.mock.calls[0]?.[0] ?? null,
          }),
        ),
    );
  }

  it('connects to the address it checked, keeping the name for TLS', async () => {
    const { error, dialled } = await connectThrough(
      resolverOf({ 'hooks.example.com': ['93.184.216.34'] }),
      'hooks.example.com',
    );

    expect(error).toBeNull();
    expect(dialled).toMatchObject({
      hostname: '93.184.216.34',
      servername: 'hooks.example.com',
    });
  });

  it('refuses a connection to a name that now resolves privately, never dialling it', async () => {
    // The rebind: the name was public when the request was checked, and its
    // records answer the metadata address by the time the connection opens.
    const { error, dialled } = await connectThrough(
      resolverOf({ 'hooks.example.com': ['169.254.169.254'] }),
      'hooks.example.com',
    );

    expect((error as { code?: string } | null)?.code).toBe(
      OUTBOUND_ADDRESS_REFUSED_CODE,
    );
    expect(dialled).toBeNull();
  });

  it('refuses a private literal a redirect points at', async () => {
    const { error, dialled } = await connectThrough(
      resolverOf({}),
      '127.0.0.1',
    );

    expect(error).not.toBeNull();
    expect(dialled).toBeNull();
  });
});
