import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import type {
  AuthService,
  CredentialHandle,
} from '../../src/auth/auth.service';
import { IS_PUBLIC_KEY } from '../../src/auth/decorators/public.decorator';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { REQUIRE_PERMISSION_KEY } from '../../src/rbac/decorators/require-permission.decorator';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  mintTraceStoreFrameToken,
  TRACE_STORE_FRAME_TTL_MS,
} from '../../src/traces/trace-store-frame';
import type { TraceStoreTransport } from '../../src/traces/trace-store-proxy';
import { TracesController } from '../../src/traces/traces.controller';
import {
  FRAME_TOKEN_REFUSAL,
  TracesService,
} from '../../src/traces/traces.service';

jest.mock('../../src/common/service-parent', () => ({
  findParentService: jest.fn(() =>
    Promise.resolve({ appName: 'web', serverId: null }),
  ),
}));

/**
 * The two halves of a Trace store frame's authorization (ADR-0075), with the
 * database, the permission check, the credential re-read and the store's
 * transport as stand-ins:
 *
 * - a frame token is minted only for a caller who passes the one check
 *   (`service: ['read']` and the entitlement to the Service);
 * - a framed request reaches the store only with a valid token for that
 *   Service, whose credential is still alive and whose Member still passes the
 *   same check, re-run as them.
 */

const SECRET = 'test-auth-secret-at-least-32-chars-long';
const SESSION: CredentialHandle = { kind: 'session', sessionId: 'session-1' };
const CTX: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const ROW = {
  traceStoreId: 'ts-1',
  serviceType: 'application',
  applicationId: 'app-1',
  composeId: null,
  enabled: true,
  retentionDays: 3,
  credential: 'ingest',
  queryCredential: 'query',
};

let row: typeof ROW | undefined;
let checkServiceAccess: jest.Mock;
let assertCredentialAlive: jest.Mock;
let open: jest.Mock;
let service: TracesService;

beforeEach(() => {
  row = { ...ROW };
  checkServiceAccess = jest.fn(() => Promise.resolve());
  assertCredentialAlive = jest.fn(() => Promise.resolve());
  // No store running: a request that gets this far is answered 409, and
  // whether `open` was called is what says it got past every check.
  open = jest.fn(() => Promise.resolve(null));
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(row ? [row] : []) }),
      }),
    }),
  } as unknown as DrizzleDB;
  service = new TracesService(
    db,
    { checkServiceAccess } as unknown as PermissionService,
    {} as RemoteExecService,
    { open } as unknown as TraceStoreTransport,
    { assertCredentialAlive } as unknown as AuthService,
    {
      getOrThrow: (key: string) => {
        expect(key).toBe('BETTER_AUTH_SECRET');
        return SECRET;
      },
    } as unknown as ConfigService,
  );
});

const req = (method = 'GET') =>
  ({
    method,
    originalUrl: '/traces/app-1/ui/t/x/search',
  }) as unknown as Request;
const res = {} as Response;

const tokenFor = (
  overrides: Partial<Parameters<typeof mintTraceStoreFrameToken>[1]> = {},
  secret = SECRET,
) =>
  mintTraceStoreFrameToken(secret, {
    serviceId: 'app-1',
    userId: 'user-1',
    organizationId: 'org-1',
    credential: SESSION,
    expiresAt: Date.now() + TRACE_STORE_FRAME_TTL_MS,
    ...overrides,
  });

describe('TracesService', () => {
  describe('minting a frame token', () => {
    it('is a GET under service: read, the route the console already reads traces with', () => {
      expect(
        Reflect.getMetadata(
          REQUIRE_PERMISSION_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method
          TracesController.prototype.frame,
        ),
      ).toEqual({ service: ['read'] });
    });

    it('hands an entitled caller the store’s UI path under a token for them, and when it expires', async () => {
      const before = Date.now();
      const view = await service.frame(CTX, SESSION, 'app-1');

      expect(checkServiceAccess).toHaveBeenCalledWith(CTX, 'app-1', 'read');
      expect(view.uiPath).toMatch(
        /^\/backend\/traces\/app-1\/ui\/t\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
      );
      const expiresAt = Date.parse(view.expiresAt);
      expect(expiresAt).toBeGreaterThanOrEqual(before + 15 * 60_000 - 1000);
      expect(expiresAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
    });

    it('mints nothing for a caller the one check refuses', async () => {
      checkServiceAccess.mockRejectedValue(
        new ForbiddenException("You don't have access to this service"),
      );

      await expect(service.frame(CTX, SESSION, 'app-1')).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('mints nothing for a Service with no traces, or with traces off', async () => {
      row = undefined;
      await expect(service.frame(CTX, SESSION, 'app-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      row = { ...ROW, enabled: false };
      await expect(service.frame(CTX, SESSION, 'app-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('a framed request', () => {
    it('is served by a public route, since a sandboxed frame sends no session', () => {
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_KEY,
          // eslint-disable-next-line @typescript-eslint/unbound-method
          TracesController.prototype.proxy,
        ),
      ).toBe(true);
    });

    it('reaches the store with a valid token, after re-reading its credential and re-running the one check as its Member', async () => {
      const token = tokenFor();

      // 409: no store running, so it got as far as asking for the store.
      await expect(
        service.proxy(token, 'app-1', req(), res),
      ).rejects.toMatchObject({ status: 409 });
      expect(assertCredentialAlive).toHaveBeenCalledWith(SESSION, 'org-1');
      expect(checkServiceAccess).toHaveBeenCalledWith(CTX, 'app-1', 'read');
      expect(open).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['no token', () => ''],
      ['a token that is not one', () => 'not-a-token'],
      ['an expired token', () => tokenFor({ expiresAt: Date.now() - 1 })],
      ['another Service’s token', () => tokenFor({ serviceId: 'app-2' })],
      [
        'a token signed by another instance',
        () => tokenFor({}, 'another-secret-at-least-32-characters'),
      ],
      [
        'a token altered to name another Member',
        () => {
          const [payload, signature] = tokenFor().split('.');
          const claims = JSON.parse(
            Buffer.from(payload, 'base64url').toString('utf8'),
          ) as Record<string, unknown>;
          const altered = Buffer.from(
            JSON.stringify({ ...claims, u: 'user-2' }),
          ).toString('base64url');
          return `${altered}.${signature}`;
        },
      ],
    ])(
      'is refused with %s, and nothing is checked or reached',
      async (_label, token) => {
        const refused = service.proxy(token(), 'app-1', req(), res);

        await expect(refused).rejects.toBeInstanceOf(UnauthorizedException);
        await expect(refused).rejects.toMatchObject({
          message: FRAME_TOKEN_REFUSAL,
        });
        expect(assertCredentialAlive).not.toHaveBeenCalled();
        expect(checkServiceAccess).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
      },
    );

    it('is refused once the credential it was minted for is revoked, and the store is not reached', async () => {
      assertCredentialAlive.mockRejectedValue(
        new UnauthorizedException('The session has been revoked'),
      );

      await expect(
        service.proxy(tokenFor(), 'app-1', req(), res),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      expect(open).not.toHaveBeenCalled();
    });

    it('is refused once its Member is no longer entitled to the Service, and the store is not reached', async () => {
      checkServiceAccess.mockRejectedValue(
        new ForbiddenException("You don't have access to this service"),
      );

      await expect(
        service.proxy(tokenFor(), 'app-1', req(), res),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(open).not.toHaveBeenCalled();
    });

    it('refuses a write verb with a valid token, and the store is not reached', async () => {
      for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        await expect(
          service.proxy(tokenFor(), 'app-1', req(method), res),
        ).rejects.toMatchObject({ status: 405 });
      }
      expect(open).not.toHaveBeenCalled();
    });

    it('answers a Service whose traces were turned off as not found', async () => {
      row = { ...ROW, enabled: false };

      await expect(
        service.proxy(tokenFor(), 'app-1', req(), res),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(open).not.toHaveBeenCalled();
    });
  });
});
