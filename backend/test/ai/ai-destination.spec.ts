import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  assertPublicApiUrl,
  isPrivateAddress,
  PRIVATE_DESTINATION_REFUSAL,
} from '../../src/ai/ai-destination';
import type { AddressResolver } from '../../src/ai/ai-destination';

/**
 * The destination half of the probe-authorization fix, at the seam where it can
 * be decided without a Postgres: what `AiService` is allowed to point the platform host at.
 *
 * A unit spec for `host-reachability.spec.ts`'s stated reason — the thing under
 * test is `new`-able, or in this case not even that — and the DNS boundary is
 * the one double it needs. The addresses in the tables below are written out
 * rather than generated from the block list the code builds: a table that
 * derives its expectation from `PRIVATE`'s own subnets would pass with every
 * subnet deleted.
 */

/** A resolver that must not be reached, for the literal-address cases. */
const noResolution: AddressResolver = () => {
  throw new Error('resolved a literal address');
};

const resolvesTo =
  (...addresses: string[]): AddressResolver =>
  () =>
    Promise.resolve(addresses);

describe('isPrivateAddress', () => {
  it.each([
    // The metadata endpoint, which is the reason this list exists.
    ['169.254.169.254', 'link-local'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback, and a spelling of it that is not 127.0.0.1'],
    ['0.0.0.0', 'this host on this network'],
    ['10.4.5.6', 'RFC 1918'],
    ['172.16.0.1', 'RFC 1918, low edge'],
    ['172.31.255.254', 'RFC 1918, high edge'],
    ['192.168.1.1', 'RFC 1918'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
    ['::1', 'IPv6 loopback'],
    ['::', 'IPv6 unspecified'],
    ['fd00::1', 'IPv6 unique local'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    // The bypass a hand-rolled matcher gets wrong: the same loopback, spelled
    // as an address of the other family.
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:169.254.169.254', 'IPv4-mapped metadata endpoint'],
    ['::7f00:1', 'IPv4-compatible loopback'],
    ['64:ff9b::a01:203', 'NAT64, embedding 10.1.2.3'],
  ])('refuses %s (%s)', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['160.254.169.254'],
    ['11.0.0.1'],
    ['172.32.0.1'],
    ['100.128.0.1'],
    ['2606:4700:4700::1111'],
    ['::ffff:8.8.8.8'],
  ])('admits the routable address %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });

  it('answers false for something that is not an address at all', () => {
    // The caller decides what an unparseable host means; this predicate does
    // not get to refuse one by calling it private.
    expect(isPrivateAddress('api.openai.com')).toBe(false);
    expect(isPrivateAddress('')).toBe(false);
  });
});

describe('assertPublicApiUrl', () => {
  it('admits a public host without consulting the private ranges twice', async () => {
    await expect(
      assertPublicApiUrl('https://api.openai.com/v1', resolvesTo('8.8.8.8')),
    ).resolves.toBeUndefined();
  });

  it('refuses the cloud metadata endpoint by address, before resolving anything', async () => {
    await expect(
      assertPublicApiUrl('http://169.254.169.254/latest/meta-data/', () => {
        throw new Error('resolved a literal address');
      }),
    ).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
  });

  it.each([
    ['http://127.0.0.1:2375/containers/json'],
    ['http://[::1]:8080/'],
    ['http://192.168.1.10:9000/'],
    ['http://10.0.0.5/'],
    // The same loopback, spelled as an IPv4-mapped IPv6 literal.
    ['http://[::ffff:127.0.0.1]:2375/'],
  ])('refuses the private literal in %s with a 403', async (apiUrl) => {
    const refusal = assertPublicApiUrl(apiUrl, noResolution);

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
  });

  it('refuses a name that resolves to loopback', async () => {
    await expect(
      assertPublicApiUrl(
        'http://localhost:11434',
        resolvesTo('127.0.0.1', '::1'),
      ),
    ).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
  });

  it('refuses a name whose records are mixed, not just one that is all private', async () => {
    // The cheap half of a rebind: one name, two records, and the private one
    // is what `getaddrinfo` may hand the fetch. Taking the first record would
    // admit this.
    await expect(
      assertPublicApiUrl(
        'https://llm.attacker.example/v1',
        resolvesTo('203.0.113.7', '169.254.169.254'),
      ),
    ).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
  });

  it('refuses a name that resolves to nothing, and one that cannot be resolved', async () => {
    await expect(
      assertPublicApiUrl('https://gone.example/v1', resolvesTo()),
    ).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);

    await expect(
      assertPublicApiUrl('https://gone.example/v1', () =>
        Promise.reject(new Error('getaddrinfo ENOTFOUND gone.example')),
      ),
    ).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
  });

  it('resolves the host and not the URL, so credentials and a path do not hide it', async () => {
    const resolve = jest.fn<Promise<string[]>, [string]>(() =>
      Promise.resolve(['10.1.2.3']),
    );

    await expect(
      assertPublicApiUrl('http://user:pw@ollama.internal:11434/v1', resolve),
    ).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
    expect(resolve).toHaveBeenCalledWith('ollama.internal');
  });

  it.each([['file:///etc/passwd'], ['gopher://127.0.0.1:70/'], ['not-a-url']])(
    'answers 400 rather than 403 for %s, which is the body being wrong',
    async (apiUrl) => {
      await expect(assertPublicApiUrl(apiUrl, noResolution)).rejects.toThrow(
        BadRequestException,
      );
    },
  );
});
