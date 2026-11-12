import {
  basicAuthUsernameSchema,
  createSecuritySchema,
  storedSecurityUserSchema,
  updateSecuritySchema,
} from '../../src/networking/security/dto/security.dto';

/**
 * H-22. `TraefikAppConfigService.regenerate` builds one `` `${username}:${hash}` ``
 * per `security` row for `basicAuth.users`, and Traefik parses each entry with
 * `strings.Split(user, ":")` behind `if len(split) != 2 { return err }`
 * (`pkg/middlewares/auth/basic_auth.go`). A `:` in the username makes three
 * parts, the middleware constructor fails, and `router.go` skips every router
 * whose chain it cannot build — so the Application 404s.
 *
 * The rule therefore has to hold on **both** halves of the sink, and the two
 * halves are separate claims: the wire (this schema, reached by the global
 * pipe) and the stored row (the same schema, reached by the emitter). Only the
 * second closes a row that predates the rule, which is why
 * {@link storedSecurityUserSchema} is asserted here as *the same rule* rather
 * than as a second one — a copy would be free to drift, and drift at a distance
 * is exactly what H-12 was.
 */
describe('basicAuthUsernameSchema', () => {
  it('refuses a username carrying the character Traefik splits an htpasswd pair on', () => {
    const refused = basicAuthUsernameSchema.safeParse('admin:$2b$10$forged');

    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0].message).toContain(
      'A colon separates the username from its password hash',
    );
  });

  it('refuses a username carrying a control character', () => {
    expect(basicAuthUsernameSchema.safeParse('adm\nin').success).toBe(false);
    expect(basicAuthUsernameSchema.safeParse('adm\u0000in').success).toBe(
      false,
    );
    expect(basicAuthUsernameSchema.safeParse('adm\u007fin').success).toBe(
      false,
    );
  });

  it('refuses an empty username and one past the length bound', () => {
    expect(basicAuthUsernameSchema.safeParse('').success).toBe(false);
    expect(basicAuthUsernameSchema.safeParse('a'.repeat(256)).success).toBe(
      false,
    );
    expect(basicAuthUsernameSchema.safeParse('a'.repeat(255)).success).toBe(
      true,
    );
  });

  it('accepts every username that authenticates today', () => {
    // The control on the refusal above, and the reason this is a refusal set
    // rather than an allow-list: each of these reaches Traefik as exactly two
    // parts, so refusing it would break a working install at the emitter to
    // close a hole that is not in it.
    for (const username of [
      'admin',
      'ops team',
      'first.last+tag@example.com',
      'josé',
      'a_b-c/d$e',
    ]) {
      expect(basicAuthUsernameSchema.safeParse(username).success).toBe(true);
    }
  });
});

describe('createSecuritySchema', () => {
  it('refuses a colon in the username on the way in', () => {
    const refused = createSecuritySchema.safeParse({
      username: 'ad:min',
      password: 'hunter2-strong',
      applicationId: 'app-1',
    });

    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0].path).toEqual(['username']);
  });
});

describe('updateSecuritySchema', () => {
  it('refuses a colon in the username, and accepts a body that omits it', () => {
    expect(updateSecuritySchema.safeParse({ username: 'ad:min' }).success).toBe(
      false,
    );
    // Nothing about the partial shape changed: a password-only PATCH is still
    // a valid body. It is the emitter, not this schema, that stops such a
    // request re-emitting a poisoned stored username.
    expect(
      updateSecuritySchema.safeParse({ password: 'new-password' }).success,
    ).toBe(true);
  });
});

describe('storedSecurityUserSchema', () => {
  it('holds a stored row to the same rule the request body is held to', () => {
    expect(
      storedSecurityUserSchema.safeParse({ username: 'ad:min' }).success,
    ).toBe(false);
    expect(
      storedSecurityUserSchema.safeParse({ username: 'admin' }).success,
    ).toBe(true);
  });
});
