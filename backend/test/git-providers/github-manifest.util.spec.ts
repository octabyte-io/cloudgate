import {
  buildGithubAppManifest,
  githubAppCreationUrl,
  githubAppInstallUrl,
} from '../../src/git-providers/strategies/github/github-manifest.util';

// The manifest document is the whole of what a one-click GitHub App creation
// produces, so what it asks for is what the app can do forever. Every
// value below is pinned against a route that exists in this backend or a
// permission some shipped call needs — not against the builder's own shape.
describe('github app manifest', () => {
  // The base every provider-facing URL hangs off: the console's origin plus
  // the prefix its rewrite proxies through to this backend.
  const params = {
    name: 'Cloudgate — Acme',
    base: 'https://console.example.com/backend',
    consoleUrl: 'https://console.example.com/settings/git-providers',
  };

  it('points GitHub at the routes this backend serves, through the console’s own origin', () => {
    const manifest = buildGithubAppManifest(params);

    // Where the app-manifest conversion code lands.
    expect(manifest.redirect_url).toBe(
      'https://console.example.com/backend/git-providers/oauth/github/setup',
    );
    // Where GitHub sends the browser after the app is installed: the
    // route that consumes `installation_id` + `state`. Without it the
    // installation ends on github.com and the installation id is never stored.
    expect(manifest.setup_url).toBe(
      'https://console.example.com/backend/git-providers/oauth/github/callback',
    );
    // A repository-selection change keeps the installation id, and GitHub
    // sends no state on that return, so there is nothing for it to finish.
    expect(manifest.setup_on_update).toBe(false);
    // The user-authorization callback. Not the install return — `setup_url`
    // is — but it has to be a route that answers all the same.
    expect(manifest.callback_urls).toEqual([
      'https://console.example.com/backend/git-providers/oauth/github/callback',
    ]);
    // GithubController's own webhook route, which is what verifies the
    // x-hub-signature-256 HMAC over a delivery.
    expect(manifest.hook_attributes).toEqual({
      url: 'https://console.example.com/backend/github/webhook',
    });
    expect(manifest.url).toBe(
      'https://console.example.com/settings/git-providers',
    );
    expect(manifest.name).toBe('Cloudgate — Acme');
  });

  it('asks for exactly the permissions and events the shipped GitHub calls need', () => {
    const manifest = buildGithubAppManifest(params);

    // contents+metadata: SourceCloneService clones. pull_requests: write is
    // GithubService.postPrComment, which comments on a preview deployment's PR.
    expect(manifest.default_permissions).toEqual({
      contents: 'read',
      metadata: 'read',
      pull_requests: 'write',
    });
    // The two events GithubController.webhook accepts beyond ping.
    expect(manifest.default_events).toEqual(['pull_request', 'push']);
    // A private app: it is installed on the org that created it, nowhere else.
    expect(manifest.public).toBe(false);
  });

  it('trims a trailing slash off the base rather than emitting a double slash', () => {
    const manifest = buildGithubAppManifest({
      ...params,
      base: 'https://console.example.com/backend/',
    });

    expect(manifest.redirect_url).toBe(
      'https://console.example.com/backend/git-providers/oauth/github/setup',
    );
  });

  describe('creation url', () => {
    it('is the personal app form, carrying the state GitHub must hand back', () => {
      expect(githubAppCreationUrl({ state: 'st_abc' })).toBe(
        'https://github.com/settings/apps/new?state=st_abc',
      );
    });

    it('is the organization app form when an organization is named', () => {
      expect(
        githubAppCreationUrl({ state: 'st_abc', organizationName: 'octabyte' }),
      ).toBe(
        'https://github.com/organizations/octabyte/settings/apps/new?state=st_abc',
      );
    });

    it('escapes an organization name and a state rather than pasting them in raw', () => {
      expect(
        githubAppCreationUrl({
          state: 'a b&c',
          organizationName: 'acme corp',
        }),
      ).toBe(
        'https://github.com/organizations/acme%20corp/settings/apps/new?state=a+b%26c',
      );
    });
  });

  describe('install url', () => {
    // The redirect after conversion: the second leg, where the app the
    // conversion just created gets installed on an account.
    it('sends the browser to the new app’s installation form with a fresh state', () => {
      expect(
        githubAppInstallUrl({ slug: 'cloudgate-acme', state: 'st_two' }),
      ).toBe(
        'https://github.com/apps/cloudgate-acme/installations/new?state=st_two',
      );
    });
  });
});
