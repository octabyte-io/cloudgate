import type { ConfigService } from '@nestjs/config';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { OwnAddresses } from '../../src/outbound/own-addresses';
import {
  isSameMachineAddress,
  SAME_MACHINE_TIMEOUT_MS,
  SameMachine,
} from '../../src/servers/same-machine';

/**
 * Which address literals are Cloudgate's own machine, for the Same-machine
 * warning: loopback and the box's own addresses, never a private range
 * (a LAN address may be another machine). The create and update round trip
 * is `server-same-machine.e2e-spec.ts`'s.
 */
describe('isSameMachineAddress', () => {
  const own = ['203.0.113.99', '2001:db8::99'];

  it.each([
    '127.0.0.1',
    '127.8.9.10',
    '::1',
    '::ffff:127.0.0.1',
    '203.0.113.99',
    '::ffff:203.0.113.99',
    '2001:db8::99',
  ])('counts %s as the box', (address) => {
    expect(isSameMachineAddress(address, own)).toBe(true);
  });

  it.each([
    '192.168.1.10',
    '10.0.0.5',
    '172.16.0.4',
    'fd00::1',
    '203.0.113.10',
    '2001:db8::1',
  ])('does not count %s as the box', (address) => {
    expect(isSameMachineAddress(address, own)).toBe(false);
  });
});

describe('SameMachine', () => {
  // The box's public address, as the install's CLOUDGATE_PUBLIC_HOST gives it:
  // on no interface, as on a cloud VM behind NAT.
  const OWN_PUBLIC = '203.0.113.10';

  const sameMachineWith = (isHosted: boolean) => {
    const mode = { isHosted } as InstanceMode;
    const resolve = (host: string) =>
      host === 'box.example.com'
        ? Promise.resolve([OWN_PUBLIC])
        : host === 'vps.example.com'
          ? Promise.resolve(['198.51.100.7'])
          : Promise.reject(new Error('NXDOMAIN'));
    return new SameMachine(
      mode,
      resolve,
      new OwnAddresses(
        resolve,
        {
          select: () => ({ from: () => Promise.resolve([]) }),
        } as unknown as DrizzleDB,
        {
          get: (name: string) =>
            name === 'CLOUDGATE_PUBLIC_HOST' ? OWN_PUBLIC : undefined,
        } as unknown as ConfigService,
        mode,
      ),
    );
  };

  describe('on a Self-hosted instance', () => {
    const sameMachine = sameMachineWith(false);

    it.each([
      '127.0.0.1',
      '::1',
      'localhost',
      'LOCALHOST',
      OWN_PUBLIC,
      'box.example.com',
    ])('a Server at %s is on the same machine', async (host) => {
      await expect(sameMachine.isSameMachine(host)).resolves.toBe(true);
    });

    it.each([
      '192.168.77.123',
      '10.200.0.7',
      '198.51.100.7',
      'vps.example.com',
      'nowhere.example.com',
    ])('a Server at %s is not on the same machine', async (host) => {
      await expect(sameMachine.isSameMachine(host)).resolves.toBe(false);
    });
  });

  describe('when a name never resolves', () => {
    const mode = { isHosted: false } as InstanceMode;
    const never = () => new Promise<string[]>(() => undefined);
    const stalled = (publicHost: string) =>
      new SameMachine(
        mode,
        never,
        new OwnAddresses(
          never,
          {
            select: () => ({ from: () => Promise.resolve([]) }),
          } as unknown as DrizzleDB,
          {
            get: (name: string) =>
              name === 'CLOUDGATE_PUBLIC_HOST' ? publicHost : undefined,
          } as unknown as ConfigService,
          mode,
        ),
      );

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it.each([
      ['the Server address', 'stuck.example.com', OWN_PUBLIC],
      ["one of the box's own names", OWN_PUBLIC, 'stuck.example.com'],
    ])(
      'answers not same-machine after %s stalls for SAME_MACHINE_TIMEOUT_MS',
      async (_what, host, publicHost) => {
        let answer: boolean | undefined;
        void stalled(publicHost)
          .isSameMachine(host)
          .then((value) => {
            answer = value;
          });

        await jest.advanceTimersByTimeAsync(SAME_MACHINE_TIMEOUT_MS - 1);
        expect(answer).toBeUndefined();
        await jest.advanceTimersByTimeAsync(1);
        expect(answer).toBe(false);
      },
    );
  });

  describe('on the Hosted instance', () => {
    const sameMachine = sameMachineWith(true);

    it.each(['127.0.0.1', '::1', 'localhost', OWN_PUBLIC, 'box.example.com'])(
      'a Server at %s is never on the same machine',
      async (host) => {
        await expect(sameMachine.isSameMachine(host)).resolves.toBe(false);
      },
    );
  });
});
