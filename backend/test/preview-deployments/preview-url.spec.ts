import { previewUrl } from '../../src/preview-deployments/preview-url';
import type { ResolverCertificate } from '../../src/preview-deployments/dns-resolver-certificates';
import type {
  PreviewCertificate,
  PreviewUrlInput,
} from '../../src/preview-deployments/preview-url';
import {
  CN_ONLY_WILDCARD_PEM,
  EXACT_PREVIEW_HOST_PEM,
  FIXTURE_NOT_AFTER,
  WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
} from './fixtures/preview-certificates';

const HOST = 'preview-web-app-abc123.preview.example.com';
const NOW = new Date('2026-09-22T20:00:00Z');

/** A preview on the platform host of `org-1`, with the wildcard set. */
const input = (over: Partial<PreviewUrlInput> = {}): PreviewUrlInput => ({
  host: HOST,
  organizationId: 'org-1',
  serverId: null,
  previewWildcard: '*.preview.example.com',
  certificates: [],
  previewDnsChallenge: false,
  resolverCertificates: [],
  now: NOW,
  ...over,
});

/** The `*.preview.example.com` wildcard, stored on `org-1`'s platform host. */
const wildcard = (
  over: Partial<PreviewCertificate> = {},
): PreviewCertificate => ({
  organizationId: 'org-1',
  serverId: null,
  certificateData: WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
  ...over,
});

describe('previewUrl', () => {
  it('is https:// when a certificate names the exact host', () => {
    expect(
      previewUrl(
        input({
          certificates: [
            {
              organizationId: 'org-1',
              serverId: null,
              certificateData: EXACT_PREVIEW_HOST_PEM,
            },
          ],
        }),
      ),
    ).toEqual({ url: `https://${HOST}` });
  });

  it('is https:// when a wildcard covers the host one label up', () => {
    expect(previewUrl(input({ certificates: [wildcard()] }))).toEqual({
      url: `https://${HOST}`,
    });
  });

  it('is http:// when the wildcard is two labels off the host', () => {
    expect(
      previewUrl(
        input({
          host: 'a.preview-web-app-abc123.preview.example.com',
          certificates: [wildcard()],
        }),
      ).url,
    ).toBe('http://a.preview-web-app-abc123.preview.example.com');
  });

  it('is http:// once the covering certificate has expired, measured now', () => {
    expect(
      previewUrl(input({ certificates: [wildcard()], now: FIXTURE_NOT_AFTER }))
        .url,
    ).toBe(`http://${HOST}`);
    // One second earlier it still covers: the bound is notAfter itself.
    expect(
      previewUrl(
        input({
          certificates: [wildcard()],
          now: new Date(FIXTURE_NOT_AFTER.getTime() - 1000),
        }),
      ).url,
    ).toBe(`https://${HOST}`);
  });

  it("is http:// when the covering certificate is another Organization's", () => {
    expect(
      previewUrl(
        input({ certificates: [wildcard({ organizationId: 'org-2' })] }),
      ).url,
    ).toBe(`http://${HOST}`);
  });

  it('is http:// when the covering certificate is on another Server', () => {
    expect(
      previewUrl(
        input({
          serverId: 'server-a',
          certificates: [wildcard({ serverId: 'server-b' })],
        }),
      ).url,
    ).toBe(`http://${HOST}`);
  });

  it("is https:// when the covering certificate is the run Server's own", () => {
    expect(
      previewUrl(
        input({
          serverId: 'server-a',
          certificates: [wildcard({ serverId: 'server-a' })],
        }),
      ).url,
    ).toBe(`https://${HOST}`);
  });

  describe('the platform-host certificate', () => {
    it('covers a preview that runs on the platform host', () => {
      expect(
        previewUrl(input({ serverId: null, certificates: [wildcard()] })).url,
      ).toBe(`https://${HOST}`);
    });

    // Its PEM is written only into the platform host's certs dir
    // (`TraefikWriterService.writeCertificate`), and a Server's preview is
    // answered by that Server's own Traefik, which never holds it.
    it('does not cover a preview that runs on a Server', () => {
      expect(
        previewUrl(input({ serverId: 'server-a', certificates: [wildcard()] }))
          .url,
      ).toBe(`http://${HOST}`);
    });
  });

  it('reads a certificate by its SANs, not a CN a browser ignores', () => {
    expect(
      previewUrl(
        input({
          certificates: [wildcard({ certificateData: CN_ONLY_WILDCARD_PEM })],
        }),
      ).url,
    ).toBe(`http://${HOST}`);
  });

  it('treats material that does not parse as covering nothing', () => {
    expect(
      previewUrl(
        input({ certificates: [wildcard({ certificateData: 'not a pem' })] }),
      ).url,
    ).toBe(`http://${HOST}`);
  });

  describe('urlNote', () => {
    it('is absent when the link is https://', () => {
      expect(
        previewUrl(input({ certificates: [wildcard()] })),
      ).not.toHaveProperty('urlNote');
    });

    it('names the wildcard no certificate covers', () => {
      expect(previewUrl(input())).toEqual({
        url: `http://${HOST}`,
        urlNote:
          'No unexpired certificate stored for the machine this preview runs on covers *.preview.example.com, so its link is http://.',
      });
    });

    it('says the host is a generated name carrying the address when no preview wildcard is set', () => {
      expect(
        previewUrl(
          input({
            host: 'preview-web-app-abc123-203-0-113-10.sslip.io',
            previewWildcard: null,
          }),
        ),
      ).toEqual({
        url: 'http://preview-web-app-abc123-203-0-113-10.sslip.io',
        urlNote:
          'This Application sets no preview wildcard, so the host is a generated sslip.io name carrying the IP of the machine this preview runs on, which no stored certificate covers, and its link is http://.',
      });
    });
  });

  /**
   * A certificate Traefik's DNS-01 resolver issued, read out of the
   * machine's `acme.json`, counts exactly as a stored one does — by the same
   * SAN and notAfter check — but only while the Application's switch is on.
   */
  describe('a certificate the DNS-01 resolver issued', () => {
    const issued = (
      over: Partial<ResolverCertificate> = {},
    ): ResolverCertificate => ({
      serverId: null,
      certificateData: WILDCARD_PREVIEW_EXAMPLE_COM_PEM,
      ...over,
    });

    it('is https:// when it covers the host and the switch is on', () => {
      expect(
        previewUrl(
          input({
            previewDnsChallenge: true,
            resolverCertificates: [issued()],
          }),
        ),
      ).toEqual({ url: `https://${HOST}` });
    });

    it('is https:// on a Server whose own acme.json holds it', () => {
      expect(
        previewUrl(
          input({
            serverId: 'server-a',
            previewDnsChallenge: true,
            resolverCertificates: [issued({ serverId: 'server-a' })],
          }),
        ).url,
      ).toBe(`https://${HOST}`);
    });

    it('is http:// once it has expired, measured now', () => {
      expect(
        previewUrl(
          input({
            previewDnsChallenge: true,
            resolverCertificates: [issued()],
            now: FIXTURE_NOT_AFTER,
          }),
        ).url,
      ).toBe(`http://${HOST}`);
    });

    it("is http:// when it was issued on another machine's Traefik", () => {
      expect(
        previewUrl(
          input({
            serverId: 'server-a',
            previewDnsChallenge: true,
            resolverCertificates: [issued({ serverId: 'server-b' })],
          }),
        ).url,
      ).toBe(`http://${HOST}`);
      // The platform host's acme.json does not cover a Server's preview.
      expect(
        previewUrl(
          input({
            serverId: 'server-a',
            previewDnsChallenge: true,
            resolverCertificates: [issued({ serverId: null })],
          }),
        ).url,
      ).toBe(`http://${HOST}`);
    });

    it('is not counted while the switch is off', () => {
      expect(
        previewUrl(
          input({
            previewDnsChallenge: false,
            resolverCertificates: [issued()],
          }),
        ),
      ).toEqual({
        url: `http://${HOST}`,
        urlNote:
          'No unexpired certificate stored for the machine this preview runs on covers *.preview.example.com, so its link is http://.',
      });
    });

    it('reads by SAN, not by a CN a browser ignores', () => {
      expect(
        previewUrl(
          input({
            previewDnsChallenge: true,
            resolverCertificates: [
              issued({ certificateData: CN_ONLY_WILDCARD_PEM }),
            ],
          }),
        ).url,
      ).toBe(`http://${HOST}`);
    });

    it('says the DNS-01 certificate is not issued yet when the switch is on and nothing covers the host', () => {
      expect(previewUrl(input({ previewDnsChallenge: true }))).toEqual({
        url: `http://${HOST}`,
        urlNote:
          'The DNS-01 certificate for *.preview.example.com has not been issued on the machine this preview runs on, so its link is http://.',
      });
    });

    it('still counts a stored certificate with the switch on', () => {
      expect(
        previewUrl(
          input({ previewDnsChallenge: true, certificates: [wildcard()] }),
        ),
      ).toEqual({ url: `https://${HOST}` });
    });
  });
});
