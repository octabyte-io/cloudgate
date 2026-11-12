import { coveringCertificate } from '../../src/domains/stored-certificate';
import {
  SHOP_EXAMPLE_COM_PEM,
  WILDCARD_EXAMPLE_COM_PEM,
  WILDCARD_EXAMPLE_ORG_PEM,
} from './fixtures/stored-certificates';

/**
 * Which stored certificate Traefik serves for a host: the one whose
 * names cover it, read out of the PEM the way Traefik matches an SNI — SANs,
 * the subject CN, a `*.` wildcard covering exactly one label — with an exact
 * name preferred over a wildcard.
 */
describe('coveringCertificate', () => {
  const exact = {
    certificateId: 'c-exact',
    name: 'shop',
    certificateData: SHOP_EXAMPLE_COM_PEM,
  };
  const wildcard = {
    certificateId: 'c-wild',
    name: 'org wildcard',
    certificateData: WILDCARD_EXAMPLE_ORG_PEM,
  };

  it('names the certificate whose SAN is the host, in any case', () => {
    expect(coveringCertificate('shop.example.com', [wildcard, exact])).toEqual({
      certificateId: 'c-exact',
      name: 'shop',
    });
    expect(coveringCertificate('Shop.Example.com', [exact])?.name).toBe('shop');
  });

  it('covers one label under a wildcard, and neither the apex nor two labels', () => {
    expect(coveringCertificate('api.example.org', [wildcard])?.name).toBe(
      'org wildcard',
    );
    expect(coveringCertificate('example.org', [wildcard])).toBeNull();
    expect(coveringCertificate('a.b.example.org', [wildcard])).toBeNull();
  });

  it('prefers an exact name over a wildcard that also covers the host', () => {
    const comWildcard = {
      certificateId: 'c-com',
      name: 'com wildcard',
      certificateData: WILDCARD_EXAMPLE_COM_PEM,
    };
    // The wildcard is listed first, and still loses to the exact name.
    expect(
      coveringCertificate('shop.example.com', [comWildcard, exact])?.name,
    ).toBe('shop');
    expect(
      coveringCertificate('blog.example.com', [comWildcard, exact])?.name,
    ).toBe('com wildcard');
  });

  it('matches an internationalized host by its punycode, as Traefik is given it', () => {
    expect(coveringCertificate('тест.example.org', [wildcard])?.name).toBe(
      'org wildcard',
    );
  });

  it('reads material that does not parse as covering nothing, rather than throwing', () => {
    const junk = {
      certificateId: 'c-junk',
      name: 'junk',
      certificateData:
        '-----BEGIN CERTIFICATE-----\nMIIBszCCAVo=\n-----END CERTIFICATE-----',
    };
    expect(coveringCertificate('shop.example.com', [junk])).toBeNull();
    expect(coveringCertificate('shop.example.com', [junk, exact])?.name).toBe(
      'shop',
    );
  });

  it('answers null when nothing is stored', () => {
    expect(coveringCertificate('shop.example.com', [])).toBeNull();
  });
});
