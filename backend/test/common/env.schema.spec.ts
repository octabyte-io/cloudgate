import { validateEnv } from '../../src/common/config/env.schema';

const validEnv = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/cloudgate',
  APP_ENCRYPTION_SECRET: 'a-long-enough-secret-value-123456',
  BETTER_AUTH_SECRET: 'another-long-enough-secret-value-42',
};

describe('env validation', () => {
  it('accepts a valid env and applies defaults', () => {
    const parsed = validateEnv(validEnv);
    expect(parsed.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(parsed.APP_ENCRYPTION_SECRET).toBe(validEnv.APP_ENCRYPTION_SECRET);
    expect(parsed.PORT).toBe(4000);
    expect(parsed.NODE_ENV).toBe('development');
  });

  it('coerces PORT from a string', () => {
    const parsed = validateEnv({ ...validEnv, PORT: '8080' });
    expect(parsed.PORT).toBe(8080);
  });

  it('throws a message naming the missing required variable', () => {
    const withoutDbUrl: Record<string, unknown> = { ...validEnv };
    delete withoutDbUrl.DATABASE_URL;
    expect(() => validateEnv(withoutDbUrl)).toThrow(/DATABASE_URL/);
  });

  it('rejects an APP_ENCRYPTION_SECRET that is too short to be safe', () => {
    expect(() =>
      validateEnv({ ...validEnv, APP_ENCRYPTION_SECRET: 'short' }),
    ).toThrow(/APP_ENCRYPTION_SECRET/);
  });

  // The CORS allowlist has to be named origins — a wildcard is not legal
  // alongside credentials — so an unset key means "no cross-origin browser
  // client", never "every origin".
  it('leaves the CORS allowlist empty when CORS_ALLOWED_ORIGINS is unset', () => {
    expect(validateEnv(validEnv).CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it('splits CORS_ALLOWED_ORIGINS on commas and trims each origin', () => {
    const parsed = validateEnv({
      ...validEnv,
      CORS_ALLOWED_ORIGINS:
        'http://localhost:3000, https://console.example.com',
    });
    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual([
      'http://localhost:3000',
      'https://console.example.com',
    ]);
  });

  it('drops empty entries from CORS_ALLOWED_ORIGINS rather than allowing ""', () => {
    const parsed = validateEnv({
      ...validEnv,
      CORS_ALLOWED_ORIGINS: ',http://localhost:3000,,',
    });
    expect(parsed.CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:3000']);
  });

  /**
   * The Template catalogue's address (ADR-0062). Pinned *here* rather than
   * through the app: `validateEnv` runs when `ConfigModule` snapshots the
   * environment as `app.module` is first imported, so an e2e can only ever
   * observe an accepted value — a refused one takes the whole app down before
   * a request exists to make. `test/templates/templates-catalogue*.e2e-spec.ts`
   * cover the accepted values end to end.
   */
  describe('CLOUDGATE_TEMPLATES_URL', () => {
    it('stays unset when not given, so the reader can tell unset from set', () => {
      expect(validateEnv(validEnv).CLOUDGATE_TEMPLATES_URL).toBeUndefined();
    });

    it('takes off, and an http or https address', () => {
      for (const value of [
        'off',
        'https://mirror.example.com/catalogue.zip',
        'http://mirror.internal:8080/catalogue.zip',
      ]) {
        expect(
          validateEnv({ ...validEnv, CLOUDGATE_TEMPLATES_URL: value })
            .CLOUDGATE_TEMPLATES_URL,
        ).toBe(value);
      }
    });

    it('refuses any other scheme, and any other word', () => {
      // Each of the addresses parses as a URL: it is the `protocol` guard that
      // turns them down. `file:` would make the catalogue the platform host's
      // own filesystem.
      for (const value of [
        'file:///etc/passwd',
        'ftp://mirror.example.com/catalogue.zip',
        'javascript:alert(1)',
        'false',
      ]) {
        expect(() =>
          validateEnv({ ...validEnv, CLOUDGATE_TEMPLATES_URL: value }),
        ).toThrow(/CLOUDGATE_TEMPLATES_URL/);
      }
    });

    it('still lets an install keeping the old CLOUDGATE_TEMPLATES_BASE_URL start', () => {
      // ADR-0066: the old key is only detected, so no value of it may stop
      // the install from booting.
      expect(
        validateEnv({
          ...validEnv,
          CLOUDGATE_TEMPLATES_BASE_URL: 'file:///not/even/http',
        }).CLOUDGATE_TEMPLATES_BASE_URL,
      ).toBe('file:///not/even/http');
    });
  });

  /**
   * The license server was the literal `https://licenses-api.cloudgate.dev`
   * inside `LicenseApiClient` with no override, so a self-hosted install could
   * not point activation at its own service and had no way round an outage of
   * the hosted one — which is not hypothetical: on the build where this was filed the
   * activation path answered an nginx 404, so no key could be activated at all.
   *
   * The default is written out here rather than imported from the schema (§1.7):
   * it is the address an existing install keeps reaching, so a typo in it has to
   * fail in this file rather than be read back out of the value that made it.
   */
  describe('LICENSE_SERVER_URL', () => {
    it('falls back to the hosted license server when it is unset', () => {
      expect(validateEnv(validEnv).LICENSE_SERVER_URL).toBe(
        'https://licenses-api.cloudgate.dev',
      );
    });

    it("takes an operator's own license service in place of the hosted one", () => {
      expect(
        validateEnv({
          ...validEnv,
          LICENSE_SERVER_URL: 'https://licenses.internal.example.com',
        }).LICENSE_SERVER_URL,
      ).toBe('https://licenses.internal.example.com');
    });

    it('trims a trailing slash, because the post appends /licenses', () => {
      // `LicenseApiClient` builds `${base}/licenses/activate`, and
      // `//licenses` is a different path on a strict server.
      expect(
        validateEnv({
          ...validEnv,
          LICENSE_SERVER_URL: 'http://licenses.internal:8080/api/',
        }).LICENSE_SERVER_URL,
      ).toBe('http://licenses.internal:8080/api');
    });

    it('refuses a license server URL whose scheme is not http or https', () => {
      for (const url of ['file:///etc/passwd', 'ftp://licenses.example.com']) {
        expect(() =>
          validateEnv({ ...validEnv, LICENSE_SERVER_URL: url }),
        ).toThrow(/LICENSE_SERVER_URL/);
      }
    });
  });
});
