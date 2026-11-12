import {
  requestOAuthCodeExchange,
  requestOAuthTokenRefresh,
} from '../../src/git-providers/oauth-refresh.util';

/**
 * Records what was sent and answers with whatever the test hands it. `body` is
 * the decoded JSON here, not `Response.body`'s stream, so it is omitted first.
 */
function stubFetch(
  response: Omit<Partial<Response>, 'body'> & { body?: unknown },
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve({
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? 'OK',
      headers: new Headers(),
      json: () => Promise.resolve(response.body ?? {}),
    } as Response);
  };
  return { fetch, calls };
}

const form = (init: RequestInit) =>
  Object.fromEntries(new URLSearchParams(init.body as URLSearchParams));

/**
 * The grant that was missing: `authorization_code`. Nothing but this records an
 * `expiresAt`, and `GitlabService.refreshToken` throws whenever `expiresAt` is
 * absent — which is why a hand-assembled GitLab connection refuses every call.
 */
describe('requestOAuthCodeExchange', () => {
  it('posts the authorization_code grant, repeating the redirect_uri verbatim', async () => {
    const { fetch, calls } = stubFetch({
      body: {
        access_token: 'gl-access',
        refresh_token: 'gl-refresh',
        expires_in: 7200,
      },
    });

    const result = await requestOAuthCodeExchange(
      fetch,
      'https://gitlab.example.com/oauth/token',
      {
        code: 'the-code',
        clientId: 'app-id',
        clientSecret: 'app-secret',
        redirectUri: 'https://cloudgate.example.com/cb',
      },
    );

    expect(result).toEqual({
      ok: true,
      grant: {
        accessToken: 'gl-access',
        refreshToken: 'gl-refresh',
        expiresIn: 7200,
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://gitlab.example.com/oauth/token');
    expect(calls[0].init.method).toBe('POST');
    // The provider compares the redirect_uri against the one it redirected to;
    // a differing value is rejected even when the code is good.
    expect(form(calls[0].init)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: 'app-id',
      client_secret: 'app-secret',
      redirect_uri: 'https://cloudgate.example.com/cb',
    });
  });

  it('reports a provider refusal rather than throwing, so the caller decides', async () => {
    const { fetch } = stubFetch({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const result = await requestOAuthCodeExchange(
      fetch,
      'https://gitlab.example.com/oauth/token',
      {
        code: 'stale',
        clientId: 'app-id',
        clientSecret: 'app-secret',
        redirectUri: 'https://cloudgate.example.com/cb',
      },
    );

    expect(result).toEqual({ ok: false, statusText: 'Unauthorized' });
  });

  it('treats a 200 with no access_token as a failure', async () => {
    // Gitea answers 200 with an `error` body for a reused code.
    const { fetch } = stubFetch({
      body: { error: 'invalid_grant', error_description: 'code used' },
    });

    const result = await requestOAuthCodeExchange(
      fetch,
      'https://gitea.example.com/login/oauth/access_token',
      {
        code: 'used',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://cloudgate.example.com/cb',
      },
    );

    expect(result).toEqual({
      ok: false,
      statusText: 'no access token in the grant response',
    });
  });

  it('reports a rotated-or-absent refresh token and an unreported lifetime as null', async () => {
    const { fetch } = stubFetch({ body: { access_token: 'only-this' } });

    const result = await requestOAuthCodeExchange(
      fetch,
      'https://gitea.example.com/login/oauth/access_token',
      {
        code: 'c',
        clientId: 'c',
        clientSecret: 's',
        redirectUri: 'https://cloudgate.example.com/cb',
      },
    );

    expect(result).toEqual({
      ok: true,
      grant: { accessToken: 'only-this', refreshToken: null, expiresIn: null },
    });
  });
});

// The pre-existing grant, re-asserted because both now share one POST.
describe('requestOAuthTokenRefresh', () => {
  it('posts the refresh_token grant and sends no redirect_uri', async () => {
    const { fetch, calls } = stubFetch({
      body: { access_token: 'fresh', expires_in: 3600 },
    });

    const result = await requestOAuthTokenRefresh(
      fetch,
      'https://gitlab.example.com/oauth/token',
      { refreshToken: 'old', clientId: 'app-id', clientSecret: 'app-secret' },
    );

    expect(result).toEqual({
      ok: true,
      grant: { accessToken: 'fresh', refreshToken: null, expiresIn: 3600 },
    });
    expect(form(calls[0].init)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old',
      client_id: 'app-id',
      client_secret: 'app-secret',
    });
  });
});
