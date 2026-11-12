import { parse } from 'yaml';
import {
  composeFileParseRefusal,
  parseComposeFile,
} from '../../src/compose/compose.utils';
import {
  createComposeSchema,
  updateComposeSchema,
} from '../../src/compose/dto/compose.dto';

/**
 * The `yaml` boundary, **real by default**: every case below parses for real,
 * and exactly one needs `parse` to raise a class outside the reachable set —
 * which no compose file can produce. `jest.spyOn` cannot reach it (the module's
 * exports are non-configurable getters: *"Cannot redefine property: parse"*),
 * so the passthrough mock is the seam, following `mail/smtp.sender.spec.ts`'
 * shape for a third-party boundary.
 */
jest.mock('yaml', () => {
  const actual = jest.requireActual<typeof import('yaml')>('yaml');
  return { ...actual, parse: jest.fn(actual.parse) };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const yaml = require('yaml') as { parse: jest.Mock };

/**
 * `composeFile` was a bare `z.string()` on both compose DTOs, so a file
 * that is not YAML reached `ComposeService.assertComposeContentClaimable`,
 * whose `readComposeHostClaims` → `parseComposeFile` chain parses unguarded —
 * and a `YAMLParseError` out of a guard documented as 400-and-409 was rendered
 * a 500.
 *
 * What is pinned here is what the e2e cannot vary cheaply: that the rule is
 * *derived* onto both schemas rather than declared twice (§2.4), which classes
 * of throw are the caller's file being wrong, and where the refusal's sentence
 * stops. The HTTP shapes are `compose-unparseable-file.e2e-spec.ts`.
 *
 * **`parse` does not raise one class.** The reachable set for caller-supplied
 * content is `YAMLParseError` — every syntax and composition failure, a stack
 * overflow on a deeply nested document included, which the library catches and
 * wraps itself — and `ReferenceError`, from the two reachable throws in
 * `Alias.resolve`: an alias whose anchor is not set, and `maxAliasCount` being
 * exceeded. A `ReferenceError` is not a `YAMLError`, so the first cut of the fix
 * re-threw both and left the 500 in place for them. `YAMLWarning` never
 * escapes *as a throw* — an unresolved tag goes to `process.emitWarning` and
 * `parse` answers normally — but this file used to record that as the end of
 * the matter and it was not: the warning is prettified, so it
 * carried a line of the operator's document to stderr. The final `describe`
 * below is that half. The yaml-1.1 `!!pairs`/`!!omap` `TypeError`s are
 * unreachable, the composer refusing those shapes as a `YAMLParseError` first;
 * the last case of the first `describe` asserts a class outside the set stays a
 * throw.
 */

const VALID = `services:
  wordpress:
    image: wordpress:6
`;

const UNPARSEABLE = 'services: [oh: no: :';

/**
 * Valid YAML that `parse` still refuses, and the reason a *syntax* rule is not
 * the whole of this one: nested anchors multiply, so ten aliases four levels
 * deep is 10^4 expansions past `parseComposeFile`'s `maxAliasCount: 10_000`.
 * 229 bytes — the billion-laughs shape is compact by construction, so pinning
 * it costs no fixture worth objecting to.
 */
const ALIAS_BOMB = `services:
  a: &a { image: alpine }
  b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
  c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
  d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
  e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]
`;

/** The ordinary version of the same class: a `*base` whose `&base` is gone. */
const UNRESOLVED_ALIAS = `services:
  app: *base
`;

const PREFIX = 'Compose file is not valid YAML';

const ALIAS_PREFIX = "Compose file's YAML aliases cannot be resolved";

/**
 * A file that parses **and** makes `yaml` emit a warning positioned on a line
 * that also carries a credential — the shape found while checking where
 * `composeFile` is echoed.
 *
 * An unresolved tag is the cheapest reachable warning of the six an
 * operator-authored document can raise (`BAD_DIRECTIVE`, `TAG_RESOLVE_FAILED`,
 * `BAD_ALIAS`, `BAD_INDENT`, the ambiguous-anchor one and the
 * may-be-parsed-as-either one), and the tag sits on the `environment:` entry so
 * the warning's own position lands on the secret's line. That is the whole
 * mechanism: `prettifyError` gives a *warning* the same treatment it gives an
 * error, so the message carries up to 80 characters of the source line plus a
 * caret.
 */
const WARNING_BEARING = `services:
  db:
    image: mariadb:11
    environment:
      - !!secretish MARIADB_ROOT_PASSWORD=${'sk-live-9f3ad2'}
`;

describe('composeFileParseRefusal', () => {
  it('answers null for content that parses', () => {
    expect(composeFileParseRefusal(VALID)).toBeNull();
  });

  it('answers null for empty content', () => {
    // The empty-file refusal is `parseComposeFileOrThrow`'s, at deploy and
    // Converted time. `composeFile` is optional on create and the column
    // defaults to empty, so refusing it here would refuse every stack created
    // before its file was written.
    expect(composeFileParseRefusal('')).toBeNull();
  });

  it('answers null for a scalar document', () => {
    // Not a compose spec, and deliberately not this rule's business: it parses,
    // and `readComposeHostClaimsFromSpec` reads no `services` off it. Whether a
    // document that parses is a *spec* is `parseComposeFileOrThrow`'s question.
    expect(composeFileParseRefusal('just a string')).toBeNull();
  });

  it('names the parse failure and where it is', () => {
    expect(composeFileParseRefusal(UNPARSEABLE)).toBe(
      `${PREFIX}: Nested mappings are not allowed in compact mappings at line 1, column 20`,
    );
  });

  it('stops before the snippet quoting the content', () => {
    // The expected value comes from the library rather than from this
    // function's own construction: the message it raises carries the failing
    // line after a blank line, and none of that may survive — `error.message`
    // out of this guard reaches a Deployment log and a build-failure
    // notification, so a caret diagram would carry an inline password outward.
    const withSecret = `services:
  db:
    environment:
      - MARIADB_ROOT_PASSWORD=hunter2-in-the-clear
     - BROKEN_INDENT=yes
`;
    expect(() => {
      parse(withSecret);
    }).toThrow(/hunter2-in-the-clear/);

    const refusal = composeFileParseRefusal(withSecret);
    expect(refusal).toBe(
      `${PREFIX}: A block sequence may not be used as an implicit map key at line 5, column 1`,
    );
    expect(refusal).not.toContain('hunter2-in-the-clear');
  });

  it('refuses valid YAML whose aliases exceed the expansion limit', () => {
    // The `ReferenceError` case, and the one input class here that is
    // deliberately hostile rather than merely broken. It is **not** a syntax
    // error — `yamllint` passes this file — so it gets its own sentence rather
    // than being told it is not valid YAML, which would send an operator
    // looking for a typo that is not there.
    expect(composeFileParseRefusal(ALIAS_BOMB)).toBe(
      `${ALIAS_PREFIX}: Excessive alias count indicates a resource exhaustion attack`,
    );
  });

  it('refuses an alias whose anchor is never set', () => {
    // The same class, reached by an ordinary mistake rather than an attack: a
    // `*base` whose `&base` was edited away. Worth its own case because it is
    // the likelier of the two and it was a 500 for exactly the same reason.
    expect(composeFileParseRefusal(UNRESOLVED_ALIAS)).toBe(
      `${ALIAS_PREFIX}: Unresolved alias (the anchor must be set before the alias): base`,
    );
  });

  it('caps a library message that interpolates caller-supplied text', () => {
    // Why the cap is load-bearing rather than defensive: the unresolved-alias
    // message interpolates the *alias name*, which is the caller's own bytes
    // and has no length bound. 500 code units is the limit for a third
    // party's words and the `…` marker is ours. The expected value is built
    // from the limit rather than by calling the code's own cap.
    const name = 'z'.repeat(600);
    const refusal = composeFileParseRefusal(`services:\n  app: *${name}\n`);

    const sentence = `Unresolved alias (the anchor must be set before the alias): ${name}`;
    expect(refusal).toBe(`${ALIAS_PREFIX}: ${sentence.slice(0, 500)}…`);
    expect(refusal).toHaveLength(ALIAS_PREFIX.length + 2 + 500 + 1);
  });

  // The cap's docblock used to credit only the alias arm and
  // said in the same breath that *"the two `YAMLParseError` shapes are bounded
  // by the library's own vocabulary and would not have needed this."* That is
  // false, and the three cases below are the measurement: several of `yaml`
  // 2.9.0's own base messages interpolate a slice of the document **before the
  // first newline**, which is exactly the half `boundUpstreamYamlMessage`
  // keeps. So the cap is load-bearing for this arm too, and a docblock calling
  // an `encryptedText` column's refusal bounded while a path prints it is the
  // shape ADR 0015's third consequence warns about.
  //
  // Each expectation is built from the library's own uncapped message rather
  // than from the code's cap, so the case fails if either the interpolation
  // stops happening or the cap stops being applied.
  describe.each([
    // `resolve-block-scalar.js`: `Block scalar header includes extra
    // characters: ${source}`, where `source` is the whole header token.
    [
      'a block scalar header',
      (secret: string) =>
        `services:\n  db:\n    command: |${secret}\n      x\n`,
    ],
    // `doc/directives.js`: `Could not resolve tag: ${source}` — an unresolved
    // tag handle, the token verbatim.
    [
      'an unresolvable tag',
      (secret: string) => `services:\n  db: !e!${secret} x\n`,
    ],
    // `doc/directives.js`: `The ${source} tag has no suffix`.
    [
      'a tag with no suffix',
      (secret: string) =>
        `%TAG !${secret}! tag:example.com,2000:\n---\nservices:\n  db: !${secret}!\n`,
    ],
  ])('a YAMLParseError interpolating %s', (_shape, build) => {
    it('is capped, so the arm the docblock called bounded is bounded here', () => {
      const secret = `S3CRET_${'x'.repeat(900)}`;
      const refusal = composeFileParseRefusal(build(secret));

      // The library really does put the operator's bytes in the first line:
      // without the cap the refusal would be longer than the prefix plus 500.
      let uncapped = '';
      try {
        parse(build(secret), { maxAliasCount: 10_000, logLevel: 'error' });
      } catch (error) {
        uncapped = (error as Error).message.split('\n')[0];
      }
      expect(uncapped).toContain(secret);
      expect(uncapped.length).toBeGreaterThan(500);

      expect(refusal).toBe(`${PREFIX}: ${uncapped.slice(0, 500)}…`);
      expect(refusal).toHaveLength(PREFIX.length + 2 + 500 + 1);
    });
  });

  it('leaves a class outside the reachable set as a throw', () => {
    // The negative claim that keeps this from becoming a blanket catch. A
    // `TypeError` is not something `parse` raises for caller-supplied content
    // (the yaml-1.1 `!!pairs`/`!!omap` ones are unreachable — the composer
    // refuses those shapes as a `YAMLParseError` first), so if one arrives it is
    // a bug on this side, and a bug rendered as a 400 blames the operator's file
    // for it. Stubbed for one call only, so the assertion after it proves the
    // stub is what answered rather than the rule having a hole.
    const bug = new TypeError(
      "Cannot read properties of undefined (reading 'x')",
    );
    yaml.parse.mockImplementationOnce(() => {
      throw bug;
    });

    expect(() => composeFileParseRefusal(VALID)).toThrow(bug);
    expect(composeFileParseRefusal(VALID)).toBeNull();
  });
});

describe('createComposeSchema', () => {
  it('refuses a composeFile that is not valid YAML at its own field path', () => {
    const result = createComposeSchema.safeParse({
      name: 'Wordpress',
      environmentId: 'env-1',
      composeFile: UNPARSEABLE,
    });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map((issue) => [
        issue.path.join('.'),
        issue.message,
      ]),
    ).toEqual([
      [
        'composeFile',
        `${PREFIX}: Nested mappings are not allowed in compact mappings at line 1, column 20`,
      ],
    ]);
  });

  it('refuses an alias bomb at the same field path', () => {
    // The DTO half has to cover the hostile input too, or `POST /compose` is
    // still the cheapest way to make the process do 10^4 expansions.
    const result = createComposeSchema.safeParse({
      name: 'Wordpress',
      environmentId: 'env-1',
      composeFile: ALIAS_BOMB,
    });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map((issue) => [
        issue.path.join('.'),
        issue.message,
      ]),
    ).toEqual([
      [
        'composeFile',
        `${ALIAS_PREFIX}: Excessive alias count indicates a resource exhaustion attack`,
      ],
    ]);
  });

  it('takes a payload with no composeFile', () => {
    expect(
      createComposeSchema.safeParse({ name: 'Wordpress', environmentId: 'e' })
        .success,
    ).toBe(true);
  });
});

describe('updateComposeSchema', () => {
  it('refuses a composeFile that is not valid YAML at its own field path', () => {
    // The same rule, on the schema that does not derive from the create one:
    // `updateComposeSchema` is its own `z.object({…}).partial()`, so the field
    // is what has to be shared (§2.4's "derive, never re-declare" applied to
    // the one field rather than to the object).
    const result = updateComposeSchema.safeParse({ composeFile: UNPARSEABLE });

    expect(result.success).toBe(false);
    expect(
      result.error?.issues.map((issue) => [
        issue.path.join('.'),
        issue.message,
      ]),
    ).toEqual([
      [
        'composeFile',
        `${PREFIX}: Nested mappings are not allowed in compact mappings at line 1, column 20`,
      ],
    ]);
  });

  it('takes a body that names other fields while carrying no composeFile', () => {
    // `.partial()`, so this is the body `update` holds against the *stored*
    // file — the reason the service-side half of the refusal cannot be deleted.
    expect(updateComposeSchema.safeParse({ name: 'Renamed' }).success).toBe(
      true,
    );
  });

  it('takes a composeFile that parses', () => {
    expect(updateComposeSchema.safeParse({ composeFile: VALID }).success).toBe(
      true,
    );
  });
});

/**
 * The column is `encryptedText`, so where its bytes are *echoed* is now
 * part of the classification rather than a detail of it — ADR 0015's third
 * consequence, because a docblock calling a column a secret while something
 * prints it is worse than the plain column was.
 *
 * Every other echo of `compose.composeFile` is either an author reading their
 * own file back behind the entitlement that stored it, or the base64
 * `echo <b64> | base64 -d` wire shape that four builders ship it to a host in
 * and that `common/logging/error-payloads.ts`' `ENCODED_FILE_BODY` elides out
 * of a failed exec. **This one was neither**, and it is the reason this
 * `describe` exists: `parse` was called without a `logLevel`, `yaml` defaults
 * that to `'warn'`, and `log.warn` is `process.emitWarning` — which, with no
 * `process.on('warning')` handler anywhere in `src/` or the harness, Node
 * formats onto process **stderr**. `parseDocument` runs
 * `doc.warnings.forEach(prettifyError(source, lineCounter))` before that, so
 * the message a warning carries is not the library's vocabulary but up to 80
 * characters of the operator's own document plus a caret.
 *
 * That leaves the entitlement model entirely — it is Cloudgate's own process
 * log, on a different machine from the stack, shipped wherever an install ships
 * stderr — and it fires on **read-only** paths: `parseComposeFile` is reached
 * by `GET /compose/:id/converted`, `GET /compose/:id/services`,
 * `composeFileParseRefusal` on every create and PATCH, `readComposeHostClaims`,
 * `composeServiceUsesMapFormLabels` once per Domain row of the stack, and
 * `composeStartCommand`. No exception is involved at any point, so `ExecError`,
 * `elideEncodedPayloads`, `elidingErrorSerializer`, `capMessage` and
 * `AllExceptionsFilter` are all downstream of a path that never reaches them.
 */
describe('parseComposeFile', () => {
  const emitted: string[] = [];

  beforeEach(() => {
    emitted.length = 0;
    // Replacing rather than spying, because `emitWarning` is what has to *not*
    // happen: a spy would let Node's default handler print the document to the
    // real stderr while the assertion passed. `jest.spyOn` restores it, so the
    // original does not have to be held by hand — which would need a
    // `this: void` annotation on a bound builtin to satisfy `unbound-method`.
    jest
      .spyOn(process, 'emitWarning')
      .mockImplementation((warning: string | Error) => {
        emitted.push(typeof warning === 'string' ? warning : warning.message);
      });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('parses a file whose tag it cannot resolve without emitting the file', () => {
    // The document still parses — that is what made this invisible. `parse`
    // answers normally, no guard is reached, the deploy proceeds, and the
    // credential is on stderr.
    expect(parseComposeFile(WARNING_BEARING)).toEqual({
      services: {
        db: {
          image: 'mariadb:11',
          environment: ['MARIADB_ROOT_PASSWORD=sk-live-9f3ad2'],
        },
      },
    });

    expect(emitted).toEqual([]);
  });

  it('still throws a parse error rather than swallowing it', () => {
    // `logLevel: 'silent'` is the other value that silences the warning and is
    // **rejected**, measured rather than read off the documentation: on
    // `services:\n  db: [unclosed`, `'silent'` makes `parse` *return*
    // `{ services: { db: ['unclosed'] } }` instead of throwing, because
    // `public-api.js` swallows `doc.errors` at that level. That would take
    // `composeFileParseRefusal`'s entire contract with it and deploy a
    // half-read document. `'error'` throws the identical `YAMLParseError` the
    // default does — this assertion is what holds the two apart.
    expect(composeFileParseRefusal('services:\n  db: [unclosed\n')).toBe(
      `${PREFIX}: Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1`,
    );
    expect(emitted).toEqual([]);
  });
});
