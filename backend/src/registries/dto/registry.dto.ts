import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const registryTypeSchema = z.enum(['selfHosted', 'cloud']);

// A registry URL: hostname[:port] only — no scheme, no shell metacharacters.
// Empty string means the default registry (Docker Hub).
export const registryUrlSchema = z
  .string()
  .refine(
    (val) =>
      val === '' ||
      /^[a-zA-Z0-9]([a-zA-Z0-9._-]*[a-zA-Z0-9])?(:\d{1,5})?$/.test(val),
    'url must be a valid hostname or hostname:port (e.g. registry.example.com or localhost:5000)',
  );

/**
 * The image-reference grammar, transcribed from `distribution/reference` —
 * `reference.go`'s EBNF and the expressions `regexp.go` composes it out of, in
 * upstream's own order so this block can be diffed against it (H-47).
 *
 *     reference       := name [ ":" tag ] [ "@" digest ]
 *     name            := [domain '/'] path
 *     domain          := host [':' port-number]
 *     host            := domain-name | \[ IPv6address \]
 *     path            := path-component ['/' path-component]*
 *     path-component  := alpha-numeric [separator alpha-numeric]*
 *
 * **Transcribed and not invented.** A Docker image reference is specified — by
 * the registry the string is ultimately handed to — and every plausible
 * hand-rolled charset for it is wrong in the same direction: a registry host
 * carries dots, a colon and a port, a tag carries dots and underscores and
 * hyphens, a digest carries a colon, and a rule that reads `:` or `.` as
 * suspicious refuses `ghcr.io/acme/app:v1.2.3-rc.1`. A rule that refuses the
 * values people actually deploy is worse than no rule, because it gets deleted.
 *
 * Two details that look like typos and are upstream's:
 *
 * - **`alpha-numeric` is lowercase-only in the path and mixed-case in the
 *   domain.** `docker pull NGINX` really is an "invalid reference format",
 *   while `Registry.Example.COM/app` really is legal — DNS is case-insensitive
 *   and a repository name is not.
 * - **`separator` is `[._]|__|[-]+`**, so `my.app`, `my_app`, `my__app` and
 *   `my--app` are all one path component and `my___app` is not.
 */
const ALPHA_NUMERIC = '[a-z0-9]+';
const SEPARATOR = '(?:[._]|__|[-]+)';
const PATH_COMPONENT = `${ALPHA_NUMERIC}(?:${SEPARATOR}${ALPHA_NUMERIC})*`;
const IMAGE_PATH = `${PATH_COMPONENT}(?:/${PATH_COMPONENT})*`;
const DOMAIN_COMPONENT = '(?:[a-zA-Z0-9]|[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9])';
const DOMAIN_NAME = `${DOMAIN_COMPONENT}(?:\\.${DOMAIN_COMPONENT})*`;
const IPV6_ADDRESS = '\\[(?:[a-fA-F0-9:]+)\\]';
const DOMAIN_AND_PORT = `(?:${DOMAIN_NAME}|${IPV6_ADDRESS})(?::[0-9]+)?`;
const TAG = '[\\w][\\w.-]{0,127}';
const DIGEST =
  '[A-Za-z][A-Za-z0-9]*(?:[-_+.][A-Za-z][A-Za-z0-9]*)*:[0-9a-fA-F]{32,}';

/**
 * `distribution/reference`'s `ReferenceRegexp`, anchored.
 *
 * JavaScript's `$` — unlike Python's — matches only at the end of the input, so
 * the anchoring really does exclude a trailing newline, which is the one thing
 * an anchored charset most often lets through (`test/registries/`'s spec pins
 * it, because nothing in the expression itself says so).
 *
 * Linear on every input, deliberately: `[a-z0-9]+(?:sep[a-z0-9]+)*` looks like
 * the classic catastrophic-backtracking shape and is not one, because the
 * separators are disjoint from the alphanumerics either side of them, so no
 * character has two ways to be consumed. Measured rather than argued — the spec
 * runs it against 20k-character non-matching inputs.
 */
const IMAGE_REFERENCE = `(?:${DOMAIN_AND_PORT}/)?${IMAGE_PATH}(?::${TAG})?(?:@${DIGEST})?`;

export const IMAGE_REFERENCE_REGEX = new RegExp(`^${IMAGE_REFERENCE}$`);

/** The same rule with `''` admitted as "no image"; see {@link imageReferenceSchema}'s
 * `allowUnset`. */
export const IMAGE_REFERENCE_OR_UNSET_REGEX = new RegExp(
  `^(?:${IMAGE_REFERENCE})?$`,
);

/** The same expression with its parts captured, so the length rule below can
 * find the `path` — upstream's `anchoredNameRegexp` folded into the reference. */
const IMAGE_REFERENCE_PARTS = new RegExp(
  `^(?:(${DOMAIN_AND_PORT})/)?(${IMAGE_PATH})(?::${TAG})?(?:@${DIGEST})?$`,
);

/**
 * `RepositoryNameTotalLengthMax` — upstream's own bound, and the only length
 * the grammar carries.
 *
 * It is on the `path`, not on the whole reference: a domain is bounded by DNS
 * and a tag by the grammar (128), so this is what stops an otherwise perfectly
 * legal reference from being a megabyte of `a`. Left as the spec's number
 * rather than a rounder one nobody could cite.
 */
const REPOSITORY_NAME_MAX_LENGTH = 255;

const pathWithinLength = (value: string): boolean => {
  const parts = IMAGE_REFERENCE_PARTS.exec(value);
  // Unreachable behind the regex check that runs first; `true` rather than a
  // throw so this refinement can never be the thing that decides a value.
  return parts ? parts[2].length <= REPOSITORY_NAME_MAX_LENGTH : true;
};

export const IMAGE_REFERENCE_MESSAGE =
  'must be a Docker image reference — [registry[:port]/]name[:tag][@digest], e.g. ghcr.io/acme/app:v1.2.3';

/**
 * What a stored image reference may be (H-47).
 *
 * **What this is standing behind.** H-34 found `dockerImage` reaching
 * `docker tag` as a bare word and fixed it by quoting the word, which is the
 * primary defence and remains it — `builders/build-strategy.ts` states the
 * rule for the tree: *the quoting is the defence, and every charset in the tree
 * is belt-and-braces behind it*. This is the half of that sentence that was
 * missing here. `dockerImage` was `z.string().nullable()` and `imagePrefix`
 * `z.string().nullish()`, so the two words `getRegistryTag` assembles had no
 * charset anywhere in the tree, and `registryUrlSchema` above — which
 * constrains exactly one of the three pieces of that word — was what made the
 * whole tag read as guarded.
 *
 * So this schema is not what makes a `docker tag` line safe. It is what makes
 * the column mean something: a value that cannot be pulled is refused at the
 * API rather than stored and failed at on the build server, and a reviewer
 * reading a sink can see a rule behind the quoting instead of nothing.
 *
 * `.regex()` rather than the `.refine()` `previewWildcardSchema` uses: that
 * field already published a `pattern` and a refinement kept the contract still,
 * whereas this column publishes nothing at all today, so the grammar is new
 * information a generated consumer wants (§2.11). The length rule is a
 * `.refine()` for the opposite reason — it is on a *part* of the string and no
 * `maxLength` could describe it honestly.
 *
 * A factory with an options object rather than a plain schema, for the reason
 * `insideDirectorySchema` is one: `allowUnset` admits `''` for a column where
 * the empty string is an *existing* spelling of "no value" and not a reference.
 * `application.dockerImage` is that column — `builtImageName` reads
 * `dockerImage || ''` and `docker.strategy.ts` answers a falsy value with
 * "Docker image not found", so `''` and `null` have always meant the same
 * thing there and the API has taken both since the column existed. Refusing it
 * now would be a gratuitous 400 for a client clearing a field. Here the
 * allowance has to move the `pattern` rather than hide in a refinement (it is
 * the grammar that changes, not a check layered on it), which costs nothing
 * because the column published no pattern at all before this.
 */
export const imageReferenceSchema = ({ allowUnset = false } = {}) =>
  z
    .string()
    .regex(
      allowUnset ? IMAGE_REFERENCE_OR_UNSET_REGEX : IMAGE_REFERENCE_REGEX,
      IMAGE_REFERENCE_MESSAGE,
    )
    .refine(pathWithinLength, {
      message: `image name may not exceed ${REPOSITORY_NAME_MAX_LENGTH} characters`,
    });

/**
 * What a registry's `imagePrefix` may be: the `path` production, and nothing
 * else (H-47).
 *
 * It is the leading segment of `getRegistryTag`'s word —
 * `[url/]<imagePrefix>/<repository>` — so the grammar that applies to it is the
 * one that applies to a path there, not the whole reference: a prefix carrying
 * its own `:tag` or a registry host would compose into a string no registry
 * accepts.
 *
 * **Mixed case is accepted where the reference schema refuses it**, because
 * `getRegistryTag` lowercases this value before it becomes a word (*"image refs
 * must be lowercase"*, `registry.utils.ts`). A Docker Hub account named
 * `AcmeCorp` is stored and pushed as `acmecorp` today, and refusing it would
 * break a real value to enforce a rule the code already enforces itself.
 *
 * **`''` stays legal and is not an oversight** — `getRegistryTag` reads
 * `imagePrefix || username`, so the empty string is how a registry says "use
 * the username", and it is what the console sends for a cleared field. The
 * same allowance `publishDirectorySchema` makes for the same reason.
 */
const PREFIX_ALPHA_NUMERIC = '[a-zA-Z0-9]+';
const PREFIX_PATH_COMPONENT = `${PREFIX_ALPHA_NUMERIC}(?:${SEPARATOR}${PREFIX_ALPHA_NUMERIC})*`;

export const IMAGE_PREFIX_REGEX = new RegExp(
  `^(?:${PREFIX_PATH_COMPONENT}(?:/${PREFIX_PATH_COMPONENT})*)?$`,
);

export const imagePrefixSchema = z
  .string()
  .max(REPOSITORY_NAME_MAX_LENGTH)
  .regex(
    IMAGE_PREFIX_REGEX,
    'imagePrefix must be an image path — one or more name segments, e.g. acme or acme/team',
  );

// Create body. The username keeps its case: AWS ECR requires exactly "AWS", and
// Docker Hub logins are case-insensitive anyway.
//
// `username` is deliberately *not* held to `imagePrefixSchema` even though
// `getRegistryTag` falls back to it for the prefix (H-47): it is a credential
// before it is a path — an ECR "AWS", an email-shaped Docker Hub login, a
// service-account name with a `@` in it — and holding it to an image grammar
// would refuse logins that work. That fallback is quoted at every sink and is
// recorded as the one piece of the tag that a charset cannot reach.
export const createRegistrySchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  username: z.string().trim().min(1, 'username cannot be empty'),
  password: z.string().min(1, 'password cannot be empty'),
  url: registryUrlSchema.default(''),
  registryType: registryTypeSchema.default('cloud'),
  imagePrefix: imagePrefixSchema.nullish(),
});

export class CreateRegistryDto extends createZodDto(createRegistrySchema) {}

// Update body (partial; registryId travels in the URL).
export const updateRegistrySchema = createRegistrySchema.partial();

export class UpdateRegistryDto extends createZodDto(updateRegistrySchema) {}

// The login test's input: the three values a `docker login` needs, off the
// create body so the rules cannot drift from what a save accepts, plus *where
// to log in from*. `serverId` is not a property of the registry but of the
// machine asking — the platform host when omitted — which is `destinations`'
// test-connection shape.
export const testRegistryConnectionSchema = createRegistrySchema
  .pick({ url: true, username: true, password: true })
  .extend({ serverId: z.string().nullish() });

export class TestRegistryConnectionDto extends createZodDto(
  testRegistryConnectionSchema,
) {}

// The saved row's test: the credential comes off the row server-side, because
// the read path strips the password and the console has nothing to send.
// `preprocess` because a caller with nothing to say sends no body at all, which
// reaches the pipe as `undefined` (`destination.dto.ts`' precedent).
export const testSavedRegistryConnectionSchema = z.preprocess(
  (value) => value ?? {},
  testRegistryConnectionSchema.pick({ serverId: true }),
);

export class TestSavedRegistryConnectionDto extends createZodDto(
  testSavedRegistryConnectionSchema,
) {}
