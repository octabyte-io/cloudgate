import { updateApplicationSchema } from '../../src/applications/dto/application.dto';

/**
 * H-41. `previewWildcard` was `z.string().startsWith('*.')` and nothing else,
 * and `PreviewDeploymentsService.ensurePreview` mints
 * `wildcard.replace('*', appName)` into `preview_deployment.domain` — a
 * hostname assembled out of a stored fragment no charset held.
 *
 * **Pre-emptive, and asserted as pre-emptive.** Nothing here claims a live
 * break: the preview host reaches one reader, the pull-request comment body,
 * and no Traefik rule at all. What these pin is that the field now carries the
 * rule its siblings carry, before a preview router is wired and the value
 * becomes a stored one nothing revisits.
 */
describe('updateApplicationSchema previewWildcard', () => {
  const parse = (previewWildcard: string | null) =>
    updateApplicationSchema.safeParse({ previewWildcard });

  /**
   * The payload shapes that reached `preview_deployment.domain` through a 200.
   * The first is the Domain injection, one field over: substituted, it is
   * ``preview-app-x4k2m9.example.com`) || Host(`victim.example.com``, which is
   * a closed `Host(` argument and an alternation of its own the day a preview
   * router reads it.
   */
  const refused = [
    [
      'a backtick closing a Host() argument',
      '*.example.com`) || Host(`victim.example.com',
    ],
    ['a second host after a slash', '*.example.com/../victim.example.com'],
    [
      'userinfo pointing the host elsewhere',
      '*.example.com@victim.example.com',
    ],
    [
      'a comma, which oauth2-proxy and Traefik slices both split',
      '*.a.com,b.com',
    ],
    ['whitespace', '*.example .com'],
    ['an underscore, which is not an RFC 1123 label', '*.pre_view.example.com'],
    ['a bare label with no dot', '*.localhost'],
    ['nothing after the wildcard', '*.'],
  ] as const;

  it.each(refused)('refuses %s', (_name, wildcard) => {
    expect(parse(wildcard).success).toBe(false);
  });

  it('still refuses a wildcard that does not start with "*."', () => {
    expect(parse('example.com').success).toBe(false);
    expect(parse('*example.com').success).toBe(false);
  });

  it('accepts the wildcards previews are actually configured with', () => {
    for (const wildcard of [
      '*.sslip.io',
      '*.example.com',
      '*.preview.example.co.uk',
      '*.my-apps.example.com',
    ]) {
      expect(parse(wildcard).success).toBe(true);
    }
  });

  it('leaves null meaning "fall back to the default wildcard"', () => {
    // `ensurePreview` reads a null column as `*.sslip.io`; refusing null here
    // would be a 400 for a client asking for the default.
    expect(parse(null).success).toBe(true);
  });
});
