import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { validateEnv } from '../../src/common/config/env.schema';

/**
 * better-auth refuses any request whose `Origin` header it does not trust
 * (`403 INVALID_ORIGIN`), and on a self-hosted instance the list it consulted
 * held exactly one reachable entry — the origin of `BETTER_AUTH_URL`, which is
 * also the base of every link better-auth generates and so cannot be moved
 * freely. The runtime allowlist that could have added a second one sits behind
 * the enterprise licence. `TRUSTED_ORIGINS` is the unlicensed lever.
 *
 * These pin the parse and, just as importantly, the refusal: an entry that
 * cannot match anything (a path, a trailing slash, a typo) has to be caught at
 * boot, because silently trusting nothing reproduces the very same
 * undiagnosable "Invalid origin" this key exists to end.
 *
 * Lives under test/auth because the behaviour is auth's, even though the key it
 * arrives through is the shared env schema.
 */
const validEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/cloudgate',
  APP_ENCRYPTION_SECRET: 'a-long-enough-secret-value-123456',
  BETTER_AUTH_SECRET: 'another-long-enough-secret-value-42',
};

describe('TRUSTED_ORIGINS', () => {
  it('is empty when nothing sets it, so an instance behaves as it did before', () => {
    expect(validateEnv(validEnv).TRUSTED_ORIGINS).toEqual([]);
  });

  it('carries a single origin through', () => {
    const parsed = validateEnv({
      ...validEnv,
      TRUSTED_ORIGINS: 'https://console.example.com',
    });
    expect(parsed.TRUSTED_ORIGINS).toEqual(['https://console.example.com']);
  });

  it('splits on commas and trims the whitespace around each entry', () => {
    const parsed = validateEnv({
      ...validEnv,
      TRUSTED_ORIGINS:
        ' https://console.example.com ,\thttps://staging.example.com ',
    });
    expect(parsed.TRUSTED_ORIGINS).toEqual([
      'https://console.example.com',
      'https://staging.example.com',
    ]);
  });

  it('keeps a non-default port, which is part of the origin a browser sends', () => {
    const parsed = validateEnv({
      ...validEnv,
      TRUSTED_ORIGINS: 'http://localhost:3000,http://192.168.1.20:3000',
    });
    expect(parsed.TRUSTED_ORIGINS).toEqual([
      'http://localhost:3000',
      'http://192.168.1.20:3000',
    ]);
  });

  it('drops empty entries rather than trusting ""', () => {
    const parsed = validateEnv({
      ...validEnv,
      TRUSTED_ORIGINS: ',http://localhost:3000,,',
    });
    expect(parsed.TRUSTED_ORIGINS).toEqual(['http://localhost:3000']);
  });

  // Each of these parses as a URL but can never equal an `Origin` header, so
  // accepting it would allowlist nothing while looking like it had.
  it.each([
    ['a path', 'https://console.example.com/dashboard'],
    ['a trailing slash', 'https://console.example.com/'],
    ['a query string', 'https://console.example.com?a=1'],
    ['credentials', 'https://user:pass@console.example.com'],
    ['a default port a browser would omit', 'https://console.example.com:443'],
    ['an upper-case host', 'https://Console.Example.com'],
  ])('refuses an origin with %s', (_, origin) => {
    expect(() => validateEnv({ ...validEnv, TRUSTED_ORIGINS: origin })).toThrow(
      /TRUSTED_ORIGINS/,
    );
  });

  it.each([
    ['no scheme', 'console.example.com'],
    ['a scheme no browser sends as an origin', 'ftp://console.example.com'],
    ['nothing but a scheme', 'https://'],
  ])('refuses an entry with %s', (_, origin) => {
    expect(() => validateEnv({ ...validEnv, TRUSTED_ORIGINS: origin })).toThrow(
      /TRUSTED_ORIGINS/,
    );
  });

  it('refuses the whole list when only one entry is malformed', () => {
    expect(() =>
      validateEnv({
        ...validEnv,
        TRUSTED_ORIGINS: 'https://console.example.com,htps://typo.example.com',
      }),
    ).toThrow(/TRUSTED_ORIGINS/);
  });

  it('says what a good entry looks like, so the typo is fixable from the message', () => {
    expect(() =>
      validateEnv({ ...validEnv, TRUSTED_ORIGINS: 'console.example.com' }),
    ).toThrow(/https:\/\/console\.example\.com/);
  });

  /**
   * AuthModule reads the key off ConfigService, and ConfigModule.forRoot
   * validates the environment when it is first imported — so what reaches
   * better-auth is that snapshot and not process.env. These boot the same
   * ConfigModule main.ts does.
   */
  describe('as AuthModule receives it', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      process.env = { NODE_ENV: 'test', ...validEnv };
    });

    afterEach(() => {
      process.env = originalEnv;
    });

    const boot = () =>
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({ ignoreEnvFile: true, validate: validateEnv }),
        ],
      }).compile();

    it('arrives as a parsed list of origins rather than the raw string', async () => {
      process.env.TRUSTED_ORIGINS =
        'https://console.example.com, http://localhost:3000';
      const moduleRef = await boot();

      expect(
        moduleRef.get(ConfigService).get<string[]>('TRUSTED_ORIGINS', []),
      ).toEqual(['https://console.example.com', 'http://localhost:3000']);
    });

    it('arrives empty when nothing sets it', async () => {
      const moduleRef = await boot();

      expect(
        moduleRef.get(ConfigService).get<string[]>('TRUSTED_ORIGINS', []),
      ).toEqual([]);
    });

    it('refuses to start at all when an entry could never match a request', async () => {
      process.env.TRUSTED_ORIGINS = 'https://console.example.com/dashboard';

      await expect(boot()).rejects.toThrow(/TRUSTED_ORIGINS/);
    });
  });
});
