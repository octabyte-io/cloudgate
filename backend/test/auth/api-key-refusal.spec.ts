import type { Auth } from '../../src/auth/auth.config';
import { AuthService } from '../../src/auth/auth.service';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';

/**
 * A key that better-auth turns down for a *named* reason must
 * not come back as the same bare 401 an unknown key does.
 *
 * `verifyApiKey` never throws for a refusal — it answers
 * `{ valid: false, error: { code, message } }` — and `validateApiKey` used to
 * drop that body on the floor and return the anonymous result for all of them.
 * On the live install that is what made a key exhausted by its ten-a-day rate
 * limit look identical to a key that was simply wrong, and the limit went
 * misdiagnosed for a whole phase.
 *
 * Unit rather than e2e for the rate-limit case specifically: `auth.config.ts`
 * now passes `rateLimit: { enabled: false }` to the plugin, so `RATE_LIMITED`
 * cannot be provoked through a live app any more. The mapping still has to be
 * right — it is what makes re-enabling a limit safe — and a stubbed
 * `verifyApiKey` is the only place left that can ask.
 *
 * The database is never reached on any of these paths: every case short-circuits
 * on `valid: false`, so a `DrizzleDB` that throws on use is the assertion that
 * it stays that way.
 */

/** An `Auth` whose only live method is `verifyApiKey`, answering `result`. */
function authRefusing(result: unknown): Auth {
  return {
    api: {
      verifyApiKey: jest.fn().mockResolvedValue(result),
    },
  } as unknown as Auth;
}

/** The instance mode, which none of these paths asks. */
const selfHosted = { isHosted: false, mode: 'self-hosted' } as InstanceMode;

/** A database that fails loudly if any of these paths tries to query it. */
const unreachableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('the database must not be reached for a refused key');
    },
  },
) as DrizzleDB;

const headers = { 'x-api-key': 'cg-a-key-the-caller-really-holds' };

/** An `Auth` whose `verifyApiKey` accepts, naming the row it matched. */
function authAccepting(keyId: string): Auth {
  return {
    api: {
      verifyApiKey: jest
        .fn()
        .mockResolvedValue({ valid: true, key: { id: keyId }, error: null }),
    },
  } as unknown as Auth;
}

/**
 * A database that answers each `select(...).from(...).where(...)` in turn with
 * the next batch of rows, and throws once the script runs out — so a path that
 * queries more than the case set up fails loudly instead of reading `undefined`.
 *
 * Hand-rolled rather than a real Postgres because what is under test is a
 * *decision* about two rows, and this is the same seam `unreachableDb` above
 * uses. `test/auth/api-key-refusal.e2e-spec.ts` is what asks the question of
 * real rows and a real route.
 */
function dbAnswering(...batches: unknown[][]): DrizzleDB {
  let next = 0;
  const rows = () => {
    if (next >= batches.length) {
      throw new Error(`no row scripted for select #${next + 1}`);
    }
    return Promise.resolve(batches[next++]);
  };
  const chain: Record<string, unknown> = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: () => rows(),
  };
  return { select: () => chain } as unknown as DrizzleDB;
}

describe('AuthService: a refused API key', () => {
  it('names a rate-limited key with 429 and when it works again', async () => {
    const service = new AuthService(
      authRefusing({
        valid: false,
        key: null,
        error: {
          code: 'RATE_LIMITED',
          message: 'Rate limit exceeded.',
          details: { tryAgainIn: 4500 },
        },
      }),
      unreachableDb,
      selfHosted,
    );

    const result = await service.validateRequest(headers);

    expect(result.session).toBeNull();
    expect(result.user).toBeNull();
    expect(result.rejection).toEqual({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'API key rate limit exceeded. Try again in 5 seconds.',
    });
  });

  it('omits the retry hint when better-auth sends no window', async () => {
    const service = new AuthService(
      authRefusing({
        valid: false,
        key: null,
        error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded.' },
      }),
      unreachableDb,
      selfHosted,
    );

    const { rejection } = await service.validateRequest(headers);

    expect(rejection?.message).toBe('API key rate limit exceeded');
  });

  it.each([
    ['USAGE_EXCEEDED', 429, 'API key has reached its usage limit'],
    ['KEY_EXPIRED', 401, 'API key has expired'],
    ['KEY_DISABLED', 401, 'API key is disabled'],
    ['USER_BANNED', 403, 'The account this API key belongs to is banned'],
  ])(
    'names a %s key rather than answering 401',
    async (code, status, message) => {
      const service = new AuthService(
        authRefusing({
          valid: false,
          key: null,
          error: { code, message: code },
        }),
        unreachableDb,
        selfHosted,
      );

      const { rejection } = await service.validateRequest(headers);

      expect(rejection).toEqual({ status, code, message });
    },
  );

  /**
   * The asymmetry is the point, not an oversight: a key string that matches
   * nothing must stay a bare 401, or the header becomes an oracle for which
   * keys exist.
   */
  it.each(['KEY_NOT_FOUND', 'INVALID_API_KEY', 'SOMETHING_NEW'])(
    'leaves %s anonymous, so an unknown key stays indistinguishable',
    async (code) => {
      const service = new AuthService(
        authRefusing({
          valid: false,
          key: null,
          error: { code, message: 'Invalid api key.' },
        }),
        unreachableDb,
        selfHosted,
      );

      const result = await service.validateRequest(headers);

      expect(result).toEqual({ session: null, user: null });
      expect(result.rejection).toBeUndefined();
    },
  );

  it('leaves a refusal with no error body at all anonymous', async () => {
    const service = new AuthService(
      authRefusing({ valid: false, key: null, error: null }),
      unreachableDb,
      selfHosted,
    );

    expect(await service.validateRequest(headers)).toEqual({
      session: null,
      user: null,
    });
  });
});

/**
 * The refusal `verifyApiKey` cannot make.
 *
 * The plugin asserts a ban inside `/api-key/delete`, a session route reading
 * `ctx.context.session.user`; the verify path has no session and never looks. So
 * every case in the block above reaches `describeApiKeyRefusal` and this one
 * cannot — the key verifies, and the account behind it is the thing that is
 * refused. It shipped as `banned: owner.banned` on the session `validateApiKey`
 * built, which is a report rather than a refusal, and the account went on
 * answering 200 on every route while its WebSocket was cut at the next renewal.
 */
describe('AuthService: a verified key whose owner is refused', () => {
  const keyRow = { id: 'key_1', referenceId: 'user_1', enabled: true };

  it('refuses a banned owner with 403 and names the account', async () => {
    const service = new AuthService(
      authAccepting(keyRow.id),
      dbAnswering([keyRow], [{ id: 'user_1', banned: true }]),
      selfHosted,
    );

    const result = await service.validateRequest(headers);

    expect(result.session).toBeNull();
    expect(result.user).toBeNull();
    expect(result.rejection).toEqual({
      status: 403,
      code: 'USER_BANNED',
      message: 'The account this API key belongs to is banned',
    });
  });

  it('refuses a key whose owner row is gone with 401', async () => {
    const service = new AuthService(
      authAccepting(keyRow.id),
      dbAnswering([keyRow], []),
      selfHosted,
    );

    const { rejection } = await service.validateRequest(headers);

    expect(rejection).toEqual({
      status: 401,
      code: 'OWNER_GONE',
      message: 'The account this API key belongs to is gone',
    });
  });

  it('admits an owner whose account carries no ban', async () => {
    const service = new AuthService(
      authAccepting(keyRow.id),
      dbAnswering(
        [keyRow],
        [
          {
            id: 'user_1',
            email: 'grace@example.com',
            banned: false,
            kind: 'human',
          },
        ],
        [{ organizationId: 'org_1', role: 'owner' }],
      ),
      selfHosted,
    );

    const result = await service.validateRequest(headers);

    expect(result.rejection).toBeUndefined();
    expect(result.session).toEqual({
      userId: 'user_1',
      activeOrganizationId: 'org_1',
    });
    expect(result.credential).toEqual({ kind: 'apiKey', apiKeyId: 'key_1' });
  });

  /**
   * `null`, not `false`, is what the column holds for an account nobody has ever
   * banned — better-auth declares `banned` nullable — so the check has to read
   * as "not banned" rather than "unknown".
   */
  it('admits an owner whose ban flag was never set', async () => {
    const service = new AuthService(
      authAccepting(keyRow.id),
      dbAnswering(
        [keyRow],
        [{ id: 'user_1', banned: null, kind: 'human' }],
        [{ organizationId: 'org_1', role: 'member' }],
      ),
      selfHosted,
    );

    const { rejection, user } = await service.validateRequest(headers);

    expect(rejection).toBeUndefined();
    expect(user?.id).toBe('user_1');
  });
});
