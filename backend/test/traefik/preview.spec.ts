import {
  createPreviewTraefikConfig,
  previewRoute,
  previewRouterTls,
} from '../../src/traefik/config/preview';

const APP = { appName: 'preview-web-app-abc123', redirects: [], security: [] };
const HOST = 'preview-web-app-abc123.preview.example.com';

/** The `websecure` router of a preview's config, by its generated name. */
const secureRouter = (dnsChallengeWildcard: string | null) =>
  createPreviewTraefikConfig(
    APP,
    previewRoute(HOST, 3000),
    dnsChallengeWildcard,
  ).http?.routers?.['preview-web-app-abc123-router-websecure-1'];

describe('previewRouterTls', () => {
  it('is empty, naming no resolver, while the DNS-01 switch is off', () => {
    expect(previewRouterTls(null)).toEqual({});
  });

  it('asks the DNS-01 resolver for the wildcard alone, with no apex SAN, while the switch is on', () => {
    expect(previewRouterTls('*.preview.example.com')).toEqual({
      certResolver: 'letsencrypt-dns',
      domains: [{ main: '*.preview.example.com' }],
    });
  });
});

describe('createPreviewTraefikConfig', () => {
  it('gives the websecure router an empty tls when no DNS-01 wildcard is named', () => {
    expect(secureRouter(null)).toEqual({
      rule: `Host(\`${HOST}\`)`,
      service: 'preview-web-app-abc123-service-1',
      middlewares: [],
      entryPoints: ['websecure'],
      tls: {},
    });
    // The default is the same file as before the fix.
    expect(createPreviewTraefikConfig(APP, previewRoute(HOST, 3000))).toEqual(
      createPreviewTraefikConfig(APP, previewRoute(HOST, 3000), null),
    );
  });

  it('gives the websecure router the DNS-01 resolver and the wildcard when one is named', () => {
    expect(secureRouter('*.preview.example.com')?.tls).toEqual({
      certResolver: 'letsencrypt-dns',
      domains: [{ main: '*.preview.example.com' }],
    });
  });

  it('leaves the web router without tls and without a redirect either way', () => {
    const web = createPreviewTraefikConfig(
      APP,
      previewRoute(HOST, 3000),
      '*.preview.example.com',
    ).http?.routers?.['preview-web-app-abc123-router-1'];
    expect(web).toEqual({
      rule: `Host(\`${HOST}\`)`,
      service: 'preview-web-app-abc123-service-1',
      middlewares: [],
      entryPoints: ['web'],
    });
  });
});
