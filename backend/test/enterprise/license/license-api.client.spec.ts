import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { validateEnv } from '../../../src/common/config/env.schema';
import type { DrizzleDB } from '../../../src/db/drizzle.module';
import type { FetchClient } from '../../../src/git-providers/fetch.provider';
import { LicenseApiClient } from '../../../src/enterprise/license/license-api.client';

/**
 * The remote license-server calls. Tested at the FETCH_CLIENT seam:
 * the request each action makes, and which of the three failure classes a
 * non-ok answer is read as.
 *
 * The sentences below are written out rather than imported from the client
 * (§1.7): a test that recomputes the expectation the way the code does would
 * still have passed on the build where the activation 404 was reported, where
 * all three classes produced the same string. The default license server is written out
 * for the same reason — it used to be a constant this file imported, so an
 * install pointed at the wrong host would have read the wrong host back.
 */
describe('LicenseApiClient', () => {
  const fetchClient = jest.fn() as jest.MockedFunction<FetchClient>;

  /** The hosted license server, which is what an unset key resolves to. */
  const DEFAULT_LICENSE_SERVER = 'https://licenses-api.cloudgate.dev';

  const validEnv = {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/cloudgate',
    APP_ENCRYPTION_SECRET: 'a-long-enough-secret-value-123456',
    BETTER_AUTH_SECRET: 'another-long-enough-secret-value-42',
  };

  /**
   * Built through `validateEnv` rather than from a bare object, so the default
   * the client falls back to is the schema's own and not one this file made up.
   */
  const configWith = (env: Record<string, unknown> = {}) =>
    new ConfigService(validateEnv({ ...validEnv, ...env }));

  /** Only `webServerSettings.findFirst` is reached, for the ip. */
  const dbWithServerIp = (serverIp: string | null) =>
    ({
      query: {
        webServerSettings: {
          findFirst: jest.fn().mockResolvedValue(serverIp ? { serverIp } : {}),
        },
      },
    }) as unknown as DrizzleDB;

  const clientWith = (
    serverIp: string | null = '203.0.113.7',
    env: Record<string, unknown> = {},
  ) =>
    new LicenseApiClient(
      fetchClient,
      dbWithServerIp(serverIp),
      configWith(env),
    );

  /**
   * The body is read with `text()` and parsed by the client, so the double is
   * a body rather than an already-parsed value — which is the whole point: an
   * answer that is not JSON has to be representable here.
   */
  const response = (
    body: string,
    { ok = true, status = ok ? 200 : 400 } = {},
  ) => ({ ok, status, text: () => Promise.resolve(body) }) as Response;

  const jsonResponse = (body: unknown, ok = true, status?: number) =>
    response(JSON.stringify(body), { ok, status });

  /** The `logger.error` lines one call wrote. */
  let logged: string[];

  beforeEach(() => {
    jest.resetAllMocks();
    logged = [];
    jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation((message: unknown) => {
        logged.push(String(message));
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('posts the key and the instance ip to the activate endpoint', async () => {
    fetchClient.mockResolvedValue(
      jsonResponse({ validUntil: '2030-06-01T00:00:00.000Z' }),
    );

    await expect(clientWith().activate('CG-TEST-KEY')).resolves.toEqual({
      validUntil: '2030-06-01T00:00:00.000Z',
    });

    expect(fetchClient).toHaveBeenCalledWith(
      'https://licenses-api.cloudgate.dev/licenses/activate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"licenseKey":"CG-TEST-KEY","ip":"203.0.113.7"}',
      },
    );
  });

  it('sends a null ip when the instance address is not configured', async () => {
    fetchClient.mockResolvedValue(jsonResponse({}));

    await clientWith(null).activate('CG-TEST-KEY');

    expect(fetchClient).toHaveBeenCalledWith(
      `${DEFAULT_LICENSE_SERVER}/licenses/activate`,
      expect.objectContaining({
        body: '{"licenseKey":"CG-TEST-KEY","ip":null}',
      }),
    );
  });

  it('reads `valid` off the validate response', async () => {
    fetchClient.mockResolvedValue(jsonResponse({ valid: true }));
    await expect(clientWith().validate('CG-TEST-KEY')).resolves.toBe(true);

    fetchClient.mockResolvedValue(jsonResponse({ valid: false }));
    await expect(clientWith().validate('CG-TEST-KEY')).resolves.toBe(false);

    expect(fetchClient).toHaveBeenLastCalledWith(
      `${DEFAULT_LICENSE_SERVER}/licenses/validate`,
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('posts to the deactivate endpoint', async () => {
    fetchClient.mockResolvedValue(jsonResponse({}));

    await clientWith().deactivate('CG-TEST-KEY');

    expect(fetchClient).toHaveBeenCalledWith(
      `${DEFAULT_LICENSE_SERVER}/licenses/deactivate`,
      expect.objectContaining({
        body: '{"licenseKey":"CG-TEST-KEY","ip":"203.0.113.7"}',
      }),
    );
  });

  /**
   * The base was the literal `https://licenses-api.cloudgate.dev` inside
   * the client, so a self-hosted install ran its activation, validation and
   * deactivation against the hosted service whatever it did — and had no way
   * round an outage of it. The three cases above already pin that an install
   * that sets nothing still reaches that address.
   */
  describe('LICENSE_SERVER_URL', () => {
    it.each(['activate', 'validate', 'deactivate'] as const)(
      'sends %s to the license service the operator named',
      async (action) => {
        fetchClient.mockResolvedValue(jsonResponse({ valid: true }));

        await clientWith('203.0.113.7', {
          LICENSE_SERVER_URL: 'https://licenses.internal.example.com',
        })[action]('CG-TEST-KEY');

        expect(fetchClient).toHaveBeenCalledWith(
          `https://licenses.internal.example.com/licenses/${action}`,
          expect.objectContaining({ method: 'POST' }),
        );
      },
    );

    it('logs the override rather than the hosted address when a call fails', async () => {
      fetchClient.mockResolvedValue(
        response('not json', { ok: false, status: 502 }),
      );

      await expect(
        clientWith('203.0.113.7', {
          LICENSE_SERVER_URL: 'http://licenses.internal:8080',
        }).activate('CG-TEST-KEY'),
      ).rejects.toThrow('502');

      expect(logged.join('\n')).toContain(
        'http://licenses.internal:8080/licenses/activate',
      );
      expect(logged.join('\n')).not.toContain(DEFAULT_LICENSE_SERVER);
    });
  });

  /**
   * The three have to be three different sentences, because the operator's
   * next move is different for each: check the key, wait and retry, check the
   * network.
   *
   * **Three *distinct* strings is not the assertion that catches this**, and
   * that is worth stating so nobody weakens the cases to it: on `f078257` the
   * three were already distinct — `Failed to activate license key`, the server's
   * own refusal, and the unreachable sentence — and the bug was that the first
   * of them described the key. What fails on that build is the pair of
   * assertions that the server-error sentence *names its status* and does not
   * name the key, and the log case below.
   */
  describe('failure classes', () => {
    /** An nginx 404 page, which is what the activation path actually answers. */
    const NGINX_404 =
      '<html><head><title>404 Not Found</title></head><body>' +
      '<center><h1>404 Not Found</h1></center>' +
      '<center>nginx/1.27.5</center></body></html>';

    const messageOf = async (call: Promise<unknown>): Promise<string> => {
      try {
        await call;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error('the call resolved, so there is no failure to describe');
    };

    it('surfaces the message the license server gives for a refusal', async () => {
      fetchClient.mockResolvedValue(
        jsonResponse({ message: 'License key already activated' }, false),
      );

      await expect(clientWith().activate('CG-USED-KEY')).rejects.toThrow(
        'License key already activated',
      );
    });

    it('names the status rather than the key when the body is not a refusal', async () => {
      fetchClient.mockResolvedValue(
        response(NGINX_404, { ok: false, status: 404 }),
      );

      const said = await messageOf(clientWith().activate('CG-GOOD-KEY'));

      expect(said).toContain('404');
      // The whole point: a path-level 404 must not read as a refused key.
      expect(said).not.toContain('Failed to activate license key');
      expect(said).toContain('nothing wrong with the key');
    });

    it('tells a 404 with an HTML body, a refusal and an unreachable host apart', async () => {
      fetchClient.mockResolvedValue(
        response(NGINX_404, { ok: false, status: 404 }),
      );
      const serverError = await messageOf(clientWith().activate('CG-TEST-KEY'));

      fetchClient.mockResolvedValue(
        jsonResponse({ message: 'Invalid license key' }, false),
      );
      const refused = await messageOf(clientWith().activate('CG-TEST-KEY'));

      fetchClient.mockRejectedValue(new Error('fetch failed'));
      const unreachable = await messageOf(clientWith().activate('CG-TEST-KEY'));

      expect(new Set([serverError, refused, unreachable]).size).toBe(3);
      expect(serverError).toContain('404');
      expect(refused).toContain('Invalid license key');
      expect(unreachable).toContain('Could not reach the license server');
      // Neither of the other two claims the server said anything about the key.
      expect(serverError).not.toContain('refused');
      expect(unreachable).not.toContain('refused');
    });

    it('reads a 5xx carrying a message as a server fault, not as a refused key', async () => {
      fetchClient.mockResolvedValue(
        jsonResponse({ message: 'Internal server error' }, false, 500),
      );

      const said = await messageOf(clientWith().validate('CG-TEST-KEY'));

      expect(said).toContain('500');
      expect(said).toContain('Internal server error');
      expect(said).not.toContain('refused this license key');
    });

    it('logs the status and the first bytes of a body it could not read', async () => {
      fetchClient.mockResolvedValue(
        response(NGINX_404, { ok: false, status: 404 }),
      );

      await expect(clientWith().activate('CG-TEST-KEY')).rejects.toThrow();

      const line = logged.join('\n');
      expect(line).toContain('/licenses/activate');
      expect(line).toContain('404');
      expect(line).toContain('nginx/1.27.5');
    });

    it('refuses to read a 200 whose body is not JSON as an answer', async () => {
      fetchClient.mockResolvedValue(
        response('<html>Sign in to this network</html>'),
      );

      // Not `false`: a captive portal must not be able to mark a key invalid.
      await expect(clientWith().validate('CG-TEST-KEY')).rejects.toThrow('200');
      expect(logged.join('\n')).toContain('Sign in to this network');
    });

    it('reports an unreachable license server rather than the transport error', async () => {
      fetchClient.mockRejectedValue(new Error('fetch failed'));

      await expect(clientWith().activate('CG-TEST-KEY')).rejects.toThrow(
        'Could not reach the license server. Check your connection or try again later.',
      );
    });

    it('treats a refused connection as unreachable too', async () => {
      const error = new Error('connect ECONNREFUSED') as Error & {
        cause?: { code?: string };
      };
      error.cause = { code: 'ECONNREFUSED' };
      fetchClient.mockRejectedValue(error);

      await expect(clientWith().deactivate('CG-TEST-KEY')).rejects.toThrow(
        'Could not reach the license server. Check your connection or try again later.',
      );
    });

    it('treats a DNS lookup that could not be completed as unreachable', async () => {
      const error = new Error('getaddrinfo EAI_AGAIN') as Error & {
        cause?: { code?: string };
      };
      error.cause = { code: 'EAI_AGAIN' };
      fetchClient.mockRejectedValue(error);

      await expect(clientWith().activate('CG-TEST-KEY')).rejects.toThrow(
        'Could not reach the license server',
      );
    });
  });
});
