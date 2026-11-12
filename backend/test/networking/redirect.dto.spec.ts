import { parse, stringify } from 'yaml';
import {
  createRedirectSchema,
  redirectRuleSchema,
  storedRedirectSchema,
  updateRedirectSchema,
} from '../../src/networking/redirects/dto/redirect.dto';
import { createRedirectMiddleware } from '../../src/traefik/config/redirect';

/**
 * H-24. `regex` and `replacement` carried no rule at create or update and are
 * interpolated into the app's dynamic config. The finding was filed as
 * *possible* hygiene — "YAML quoting saves them today" — with the instruction
 * to prove that before believing it, because a writer that can be escaped makes
 * this a live break rather than hygiene.
 *
 * So the proof comes first, and it is a property of the writer rather than of
 * these two fields: the config goes through `yaml`'s `stringify`
 * (`TraefikWriterService.writeConfig`), and nothing either field can carry
 * survives it as structure.
 */
describe('createRedirectMiddleware, through the YAML writer', () => {
  /**
   * Every shape that could plausibly escape a YAML scalar, as both fields, put
   * through the exact `stringify` the writer uses and read back.
   *
   * **Not a regression test, and deliberately not written as one.** It passes
   * before the schema exists and after, because the claim it pins is that the
   * *sink* is safe — which is what makes the bounds below hygiene rather than a
   * security fix. Deleting it would leave that claim asserted only in a
   * docblock.
   */
  const escapes = [
    [
      'a document separator carrying a forged router tree',
      '---\nhttp:\n  routers:\n    pwn:\n      rule: Host(`x`)',
    ],
    ['a CRLF and a second key', 'a\r\nb: c'],
    ['a bare NUL', '\u0000nul'],
    ['a leading byte-order mark', '﻿bom'],
    ['an end-of-document marker', '...\nkey: v'],
    ['YAML alias, anchor and tag syntax', '*alias &anchor !!tag'],
    ['a comment introducing a second key', '#comment\nregex: other'],
    ['every quote character at once', '\' quote " both `'],
    ['tabs', '\t\tindent'],
    ['bare newlines', '\n\n\n'],
  ] as const;

  it.each(escapes)(
    'quotes %s rather than emitting it as structure',
    (_name, payload) => {
      const config = {
        http: {
          middlewares: createRedirectMiddleware('blog-app', {
            uniqueConfigKey: 1,
            regex: payload,
            replacement: payload,
          }),
        },
      };

      const back = parse(stringify(config)) as typeof config;

      expect(back).toEqual(config);
      expect(Object.keys(back.http.middlewares)).toEqual([
        'redirect-blog-app-1',
      ]);
      const middleware = back.http.middlewares['redirect-blog-app-1'] as {
        redirectRegex: Record<string, unknown>;
      };
      expect(Object.keys(middleware.redirectRegex)).toEqual([
        'regex',
        'replacement',
      ]);
    },
  );
});

/**
 * The bounds themselves, then, are hygiene on a `text` column with no length
 * and no readability rule — and they are asserted on the *stored* schema as
 * well as the wire one, because `updateRedirectSchema` is `.partial()` and a
 * bound only half the writes reach is not a bound.
 */
describe('redirectRuleSchema', () => {
  it('refuses a rule past the length bound', () => {
    expect(redirectRuleSchema.safeParse('a'.repeat(1024)).success).toBe(true);
    const refused = redirectRuleSchema.safeParse('a'.repeat(1025));
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0].message).toContain('at most 1024');
  });

  it('refuses a rule carrying a control character', () => {
    expect(redirectRuleSchema.safeParse('^/old\u0000$').success).toBe(false);
    expect(redirectRuleSchema.safeParse('^/old\n$').success).toBe(false);
  });

  it('accepts the regex syntax Traefik actually takes', () => {
    // The control on the refusals: a charset would have had to guess at these,
    // which is why the schema does not use one. `(?i)` and `(?P<name>…)` are
    // valid Go and a SyntaxError in V8 — they are here to pin that this schema
    // is not quietly compile-checking in the wrong dialect.
    for (const rule of [
      '^http://localhost/(.*)',
      '(?i)^https?://EXAMPLE\\.com/(.*)$',
      '(?P<slug>[a-z-]+)',
      'https://example.com/${1}',
      '^/$',
    ]) {
      expect(redirectRuleSchema.safeParse(rule).success).toBe(true);
    }
  });
});

describe('createRedirectSchema', () => {
  it('refuses a control character in either field on the way in', () => {
    expect(
      createRedirectSchema.safeParse({
        regex: '^/old\u0000',
        replacement: '/new',
        applicationId: 'app-1',
      }).success,
    ).toBe(false);
    expect(
      createRedirectSchema.safeParse({
        regex: '^/old',
        replacement: 'a'.repeat(1025),
        applicationId: 'app-1',
      }).success,
    ).toBe(false);
  });
});

describe('updateRedirectSchema', () => {
  it('refuses an out-of-bounds rule, and accepts a body that omits both fields', () => {
    expect(
      updateRedirectSchema.safeParse({ regex: 'a'.repeat(1025) }).success,
    ).toBe(false);
    // Unchanged: a `permanent`-only PATCH is still a valid body. It is the
    // emitter, not this schema, that stops such a request re-emitting a stored
    // rule the bound would refuse.
    expect(updateRedirectSchema.safeParse({ permanent: true }).success).toBe(
      true,
    );
  });
});

describe('storedRedirectSchema', () => {
  it('holds a stored row to the same rule the request body is held to', () => {
    expect(
      storedRedirectSchema.safeParse({
        regex: 'a'.repeat(1025),
        replacement: '/new',
      }).success,
    ).toBe(false);
    expect(
      storedRedirectSchema.safeParse({ regex: '^/old', replacement: '/new' })
        .success,
    ).toBe(true);
  });
});
