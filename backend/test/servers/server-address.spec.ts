import {
  createServerSchema,
  updateServerSchema,
} from '../../src/servers/dto/server.dto';
import { isServerAddress } from '../../src/servers/server-address';

/**
 * A Server's address is an IP address or a hostname. `bad host!!` used
 * to be saved, and surfaced only later as `getaddrinfo ENOTFOUND` on
 * Infrastructure. The console's copy of this rule is pinned against the same
 * cases in `frontend/src/features/server/fleet/server-address.test.ts`.
 */
describe('isServerAddress', () => {
  it.each([
    '203.0.113.10',
    '10.0.0.1',
    '2001:db8::1',
    '::1',
    'localhost',
    'vps.example.com',
    'vps-1.example.com.',
    'host-with-digits-123',
  ])('accepts %s', (address) => {
    expect(isServerAddress(address)).toBe(true);
  });

  it.each([
    'bad host!!',
    'ssh://203.0.113.10',
    '203.0.113.10:22',
    'root@203.0.113.10',
    '-leading.example.com',
    'trailing-.example.com',
    'double..dot',
    `${'a'.repeat(64)}.example.com`,
    '',
  ])('refuses %j', (address) => {
    expect(isServerAddress(address)).toBe(false);
  });
});

describe('createServerSchema and updateServerSchema', () => {
  const base = { name: 'vps-a', sshKeyId: 'key-1' };

  it('refuses an address that is neither an IP nor a hostname, on create and on update', () => {
    expect(
      createServerSchema.safeParse({ ...base, ipAddress: 'bad host!!' })
        .success,
    ).toBe(false);
    expect(
      updateServerSchema.safeParse({ ipAddress: 'bad host!!' }).success,
    ).toBe(false);
  });

  it('trims what it accepts', () => {
    const parsed = createServerSchema.parse({
      ...base,
      ipAddress: ' 203.0.113.10 ',
    });
    expect(parsed.ipAddress).toBe('203.0.113.10');
  });
});
