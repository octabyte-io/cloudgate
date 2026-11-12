import {
  imagePrefixSchema,
  imageReferenceSchema,
  updateRegistrySchema,
} from '../../src/registries/dto/registry.dto';
import { SEPARATOR_PAYLOAD, SHELL_PAYLOAD } from '../utils/shell-safety';

const DIGEST = `sha256:${'a'.repeat(64)}`;

/**
 * H-47. H-34 fixed the sinks — `docker tag`, `docker push` and the two `echo`s
 * beside them all `quote()` their words now, and that is the defence. What it
 * could not fix from where it stood is that there was nothing behind the
 * quoting: `dockerImage` was `z.string().nullable()` and `imagePrefix`
 * `z.string().nullish()`, so of the three pieces `getRegistryTag` assembles
 * into one word, only `registry.url` carried a rule — which is precisely the
 * arrangement that reads as guarded and is not.
 *
 * These pin the grammar, and the *legitimate* half is asserted as deliberately
 * as the hostile half: a charset that refuses `ghcr.io/acme/app:v1.2.3-rc.1` or
 * `registry:5000/team/app@sha256:…` is worse than no charset, because it gets
 * deleted the first time somebody cannot deploy. Several of the accepted values
 * are the literals the tree's own suites already deploy, so a rule that moved
 * under them would fail here first.
 */
describe('imageReferenceSchema', () => {
  const parse = (value: string) => imageReferenceSchema().safeParse(value);
  const accepts = (value: string) => parse(value).success;

  describe('the references people actually deploy', () => {
    // Every one of these is a reference a registry serves today. The last four
    // are this repo's own pinned literals — `deployment-engine.service.spec.ts`,
    // `rollbacks.e2e-spec.ts`, `docker.strategy.spec.ts` and the six database
    // engines' column defaults — so a grammar that narrowed under them would be
    // caught here rather than in a deploy.
    const references: Array<[string, string]> = [
      ['a bare official image', 'nginx'],
      ['an image and a tag', 'nginx:latest'],
      ['a tag carrying dots', 'postgres:16.2'],
      ['a tag carrying dots and hyphens', 'nginx:1.27.4-alpine'],
      ['a two-component path', 'library/nginx'],
      ['a registry host and a path', 'docker.io/library/nginx:1.27'],
      ['a prerelease tag', 'ghcr.io/acme/app:v1.2.3-rc.1'],
      ['a registry with a port', 'localhost:5000/app'],
      ['a port, a deep path and a tag', 'registry:5000/team/app:v1'],
      ['a digest instead of a tag', `nginx@${DIGEST}`],
      ['a port and a digest', `registry:5000/team/app@${DIGEST}`],
      ['a tag and a digest together', `nginx:1.27@${DIGEST}`],
      ['a sha512 digest', `ghcr.io/acme/app@sha512:${'b'.repeat(128)}`],
      ['an ECR host', '123456789012.dkr.ecr.eu-west-1.amazonaws.com/team/app'],
      ['a four-segment path', 'registry.example.com:5000/acme/sub/team/app:v1'],
      ['a public ECR alias', 'public.ecr.aws/lambda/nodejs:20'],
      [
        'a Microsoft registry image',
        'mcr.microsoft.com/dotnet/aspnet:8.0-alpine',
      ],
      ['a Quay image', 'quay.io/prometheus/node-exporter:v1.8.2'],
      ['a distroless image', 'gcr.io/distroless/static-debian12:nonroot'],
      ['an IPv6 registry host', '[::1]:5000/app:v1'],
      ['an underscore separator', 'my_app:latest'],
      ['a double-underscore separator', 'my__app:latest'],
      ['a dot separator', 'my.app:latest'],
      ['a repeated-hyphen separator', 'my--app:latest'],
      ['an underscore in a tag', 'python:3.12-slim_bookworm'],
      [
        'the push tag the engine spec pins',
        'registry.acme.dev/pusher/shop-api-x1:latest',
      ],
      [
        'the rollback tag the rollbacks e2e pins',
        'registry.example.com/acme/web:1',
      ],
      ['the strategy spec’s image', 'registry.example.com/team/api:v2'],
      ['a database engine column default', 'postgres:18'],
    ];

    it.each(references)('accepts %s', (_name, reference) => {
      expect(accepts(reference)).toBe(true);
    });
  });

  describe('what a reference is not', () => {
    // The first is H-34's live payload, verbatim from the commit that quoted
    // the sink it reached; the rest are the shapes a metacharacter takes when
    // the sink stops being quoted, plus the two the grammar rules out on
    // Docker's own terms.
    const refused: Array<[string, string]> = [
      ['H-34’s payload', `nginx:${SEPARATOR_PAYLOAD}`],
      ['a command substitution', `nginx:${SHELL_PAYLOAD}`],
      ['a backtick substitution', 'nginx:a`id`'],
      ['a separator', 'nginx; id'],
      ['a pipe', 'nginx|id'],
      ['an and-list', 'nginx:v1 && id'],
      ['a redirect', 'nginx > /etc/passwd'],
      ['a single quote', "nginx:'"],
      ['a double quote', 'nginx:"'],
      ['a backslash', 'nginx:v1\\'],
      ['an embedded newline', 'nginx:latest\nrm -rf /'],
      ['a trailing newline', 'nginx:latest\n'],
      ['a leading space', ' nginx'],
      ['a trailing space', 'nginx '],
      ['an uppercase repository, which docker pull refuses too', 'NGINX'],
      ['an uppercase path segment', 'docker.io/Library/nginx'],
      ['a colon with no tag', 'nginx:'],
      ['a tag with no name', ':latest'],
      ['a trailing slash', 'nginx/'],
      ['a leading slash', '/nginx'],
      ['a path component opening with a separator', '-nginx'],
      ['a triple underscore, which is not a separator', 'my___app'],
      ['a non-hex digest', 'nginx@sha256:zzzz'],
      ['a digest under 32 hex characters', `nginx@sha256:${'a'.repeat(31)}`],
      ['the empty string', ''],
    ];

    it.each(refused)('refuses %s', (_name, value) => {
      expect(accepts(value)).toBe(false);
    });

    // Not a duplicate of the row above it: JavaScript's `$` matches only at the
    // end of the input, unlike Python's, and an anchored charset that got that
    // wrong would let a whole second line through while every other row here
    // still passed. Nothing in the expression itself says which language it is
    // being read by, so it is asserted rather than assumed.
    it('anchors at the end of the input rather than at the end of a line', () => {
      expect(accepts('nginx:latest\ntouch /tmp/h47-pwn')).toBe(false);
      expect(accepts('nginx:latest\n')).toBe(false);
    });

    it('names the grammar in its refusal rather than reporting a bare pattern', () => {
      const result = parse('nginx:a$(id)');

      expect(result.success).toBe(false);
      expect(result.error?.issues[0].message).toContain('image reference');
    });
  });

  describe('the length the grammar carries', () => {
    // `RepositoryNameTotalLengthMax`, upstream's own bound and the only length
    // in the spec. Without it a reference is unbounded and perfectly legal at a
    // megabyte, which is a stored column and a command line.
    it('accepts an image name of exactly 255 characters', () => {
      expect(accepts('a'.repeat(255))).toBe(true);
    });

    it('refuses an image name of 256 characters', () => {
      expect(accepts('a'.repeat(256))).toBe(false);
    });

    it('measures the name and not the registry host or the tag', () => {
      expect(
        accepts(
          `registry.example.com:5000/${'a'.repeat(255)}:${'v'.repeat(128)}`,
        ),
      ).toBe(true);
    });
  });

  /**
   * `[a-z0-9]+(?:sep[a-z0-9]+)*` is the shape catastrophic backtracking is
   * usually written as, so the claim that this one is linear is measured rather
   * than argued. A genuinely quadratic expression takes minutes on the longest
   * of these; the budget is deliberately loose, because what would fail here is
   * an order of magnitude and not a millisecond.
   */
  it('decides a 20k-character non-matching input without backtracking', () => {
    const started = Date.now();
    for (const evil of [
      `${'a'.repeat(20_000)}!`,
      `${'a.'.repeat(10_000)}!`,
      `${'a-'.repeat(10_000)}!`,
      `${'a_'.repeat(10_000)}!`,
      `registry.example.com/${'a'.repeat(20_000)}!`,
    ]) {
      expect(accepts(evil)).toBe(false);
    }

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  describe('allowUnset', () => {
    // `''` is `application.dockerImage`'s existing spelling of "no image" —
    // `builtImageName` reads `dockerImage || ''` and `docker.strategy.ts`
    // answers a falsy value with "Docker image not found" — so the option
    // exists to keep a payload the API has always taken, and nothing more.
    it('admits the empty string as "no image" when a column asks for it', () => {
      expect(
        imageReferenceSchema({ allowUnset: true }).safeParse('').success,
      ).toBe(true);
    });

    it('admits nothing else the strict rule refuses', () => {
      expect(
        imageReferenceSchema({ allowUnset: true }).safeParse(
          `nginx:${SEPARATOR_PAYLOAD}`,
        ).success,
      ).toBe(false);
    });
  });
});

/**
 * H-47, the other half of `getRegistryTag`'s word. `imagePrefix` is the
 * segment between the registry host and the repository name —
 * `[url/]<prefix>/<repository>` — and it was `z.string().nullish()`, so the
 * leading part of every pushed tag was unconstrained while `registryUrlSchema`
 * one field above made the tag look guarded.
 */
describe('imagePrefixSchema', () => {
  const accepts = (value: string) => imagePrefixSchema.safeParse(value).success;

  it.each([
    ['a Docker Hub account', 'octabyte'],
    ['a two-segment namespace', 'acme/team'],
    ['a hyphenated account', 'acme-corp'],
    ['an underscore', 'acme_corp'],
    ['a dot', 'acme.corp'],
    ['digits', 'team42'],
    ['the empty string, which means "use the username"', ''],
    // `getRegistryTag` lowercases this value before it becomes a word
    // ("image refs must be lowercase"), so an account named `AcmeCorp` pushes
    // to `acmecorp` today and refusing it would break a real value to enforce
    // a rule the code already enforces itself.
    ['mixed case, which getRegistryTag lowercases', 'AcmeCorp'],
  ])('accepts %s', (_name, value) => {
    expect(accepts(value)).toBe(true);
  });

  it.each([
    ['a command substitution', SHELL_PAYLOAD],
    ['H-34’s payload', SEPARATOR_PAYLOAD],
    ['a separator', 'acme; id'],
    ['a space', 'acme corp'],
    ['a trailing newline', 'acme\n'],
    ['a registry host, which belongs in url', 'registry.example.com:5000/acme'],
    ['a tag, which the repository name carries', 'acme:v1'],
    ['a leading slash', '/acme'],
    ['a trailing slash', 'acme/'],
  ])('refuses %s', (_name, value) => {
    expect(accepts(value)).toBe(false);
  });

  it('refuses a prefix longer than the name it becomes part of may be', () => {
    expect(accepts('a'.repeat(255))).toBe(true);
    expect(accepts('a'.repeat(256))).toBe(false);
  });
});

describe('updateRegistrySchema', () => {
  it('refuses an imagePrefix that would put a second command in a push tag', () => {
    expect(
      updateRegistrySchema.safeParse({ imagePrefix: SEPARATOR_PAYLOAD })
        .success,
    ).toBe(false);
  });

  it('keeps taking null, which is how a registry says it has no prefix', () => {
    expect(updateRegistrySchema.safeParse({ imagePrefix: null }).success).toBe(
      true,
    );
  });

  // The username is `getRegistryTag`'s fallback prefix and is deliberately
  // *not* held to the image grammar: it is a credential first — an ECR "AWS",
  // an email-shaped Docker Hub login — and refusing those would break logins
  // that work. Asserted so the omission reads as a decision and not a miss.
  it('leaves the username, which is the fallback prefix, to the quoting at its sinks', () => {
    expect(updateRegistrySchema.safeParse({ username: 'AWS' }).success).toBe(
      true,
    );
    expect(
      updateRegistrySchema.safeParse({ username: 'user@example.com' }).success,
    ).toBe(true);
  });
});
