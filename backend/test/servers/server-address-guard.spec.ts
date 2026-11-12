import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { OwnAddresses } from '../../src/outbound/own-addresses';
import {
  isRefusedServerAddress,
  ServerAddressGuard,
} from '../../src/servers/server-address-guard';

/**
 * Which address literals the Hosted instance refuses to dial as a
 * Server. The HTTP and SSH-connect behaviour is pinned in
 * `server-address-refusal.e2e-spec.ts`; this is the classification alone.
 */
describe('isRefusedServerAddress', () => {
  const own = ['203.0.113.99', '2001:db8::99'];

  it.each([
    '127.0.0.1',
    '127.8.9.10',
    '::1',
    '::ffff:127.0.0.1',
    '0.0.0.0',
    '169.254.169.254',
    'fe80::1',
    '10.0.0.5',
    '172.16.0.4',
    '192.168.1.10',
    '100.64.0.1',
    'fd00::1',
    '203.0.113.99',
    '::ffff:203.0.113.99',
    '2001:db8::99',
    'vps.example.com',
  ])('refuses %s', (address) => {
    expect(isRefusedServerAddress(address, own)).toBe(true);
  });

  it.each(['203.0.113.10', '198.51.100.7', '2001:db8::1', '8.8.8.8'])(
    'allows %s',
    (address) => {
      expect(isRefusedServerAddress(address, own)).toBe(false);
    },
  );
});

/**
 * 6to4 (`2002::/16`) is delivered to the IPv4 address it embeds, so a Server
 * address spelt that way is the IPv4 it names.
 */
describe('isRefusedServerAddress, for a 6to4 address', () => {
  const own = ['203.0.113.99'];

  it.each([
    ['loopback', '2002:7f00:1::'],
    ['the cloud metadata endpoint', '2002:a9fe:a9fe::1'],
    ['a private range', '2002:c0a8:10a::'],
    ["the box's own public address", '2002:cb00:7163::1'],
  ])('refuses %s', (_what, address) => {
    expect(isRefusedServerAddress(address, own)).toBe(true);
  });

  it('allows a public IPv4 that is not the box', () => {
    expect(isRefusedServerAddress('2002:808:808::', own)).toBe(false);
  });
});

describe('ServerAddressGuard, on the Hosted instance', () => {
  const guardWith = (env: Record<string, string>) => {
    const hosted = { isHosted: true } as InstanceMode;
    const resolve = (host: string) =>
      host === 'cloudgate.octabyte.app'
        ? Promise.resolve(['198.51.100.20'])
        : Promise.reject(new Error('NXDOMAIN'));
    return new ServerAddressGuard(
      hosted,
      resolve,
      new OwnAddresses(
        resolve,
        {
          select: () => ({ from: () => Promise.resolve([]) }),
        } as unknown as DrizzleDB,
        { get: (name: string) => env[name] } as unknown as ConfigService,
        hosted,
      ),
    );
  };

  it('refuses the public address the install was given, which is on no interface', async () => {
    await expect(
      guardWith({ CLOUDGATE_PUBLIC_HOST: '203.0.113.10' }).addressToDial(
        '203.0.113.10',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it("refuses the address the Instance's own hostname resolves to", async () => {
    await expect(
      guardWith({ SITE_URL: 'https://cloudgate.octabyte.app' }).addressToDial(
        '198.51.100.20',
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('dials any other public address', async () => {
    await expect(
      guardWith({
        CLOUDGATE_PUBLIC_HOST: '203.0.113.10',
        SITE_URL: 'https://cloudgate.octabyte.app',
      }).addressToDial('203.0.113.77'),
    ).resolves.toBe('203.0.113.77');
  });
});
