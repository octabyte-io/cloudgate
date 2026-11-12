import {
  DOCKER_LABEL_NAMESPACE,
  REFUSED_LABEL_NAMESPACES,
} from '../native/docker-locks';
import {
  INVALID_HOSTNAME_MESSAGE,
  VALID_HOSTNAME_REGEX,
} from '../domains/dto/domain.dto';
import type {
  ComposeLabels,
  ComposeServiceSpec,
  ComposeSpecification,
} from './compose.types';

/**
 * The author-supplied compose label guard (H-83).
 *
 * **What was open.** A compose file's own `traefik.*` labels reached the
 * deployed spec verbatim on every branch. `addDomainsToComposeSpec` only ever
 * `unshift`es and `splice`es — it never reads, filters or removes an author key
 * — and map-form labels it leaves untouched entirely, so an array-only guard
 * would have shipped with a bypass in the same file. Nothing downstream refuses
 * them either: the shipped `deploy/traefik/traefik.yml.example` runs
 * `providers.docker` with no `constraints:`, and `exposedByDefault: false` is
 * not a guard because an author can write `traefik.enable=true` themselves —
 * Cloudgate's own injector writes exactly that line. So an author could define
 * ``traefik.http.routers.<n>.rule=Host(`victim.example.com`)`` and take over
 * another tenant's hostname on the shared Traefik. That is H-56's reproduced
 * cross-tenant hijack, arriving through the door H-56 closed for an
 * Application's Swarm labels and left open for a Compose stack's file.
 *
 * **Why this is not H-56's rule again.** H-56 refuses the whole `traefik.*`
 * namespace, which is correct there because *nothing Cloudgate deploys as an
 * Application carries a traefik service label* — its routing is the file
 * provider. On the compose path a blanket refusal breaks real published
 * compose files (from the old `template.toml` catalogue): **wikijs**, **qbittorrent** and **fivem** carry
 * `traefik.enable=true`, wikijs and appwrite add
 * `traefik.constraint-label-stack=…`, and **crowdsec** carries a deliberate
 * `traefik.enable=false` opt-out. Refusing the namespace would refuse four
 * working stacks to close one surface.
 *
 * **So the rule is ownership, not namespace: `traefik.*` stays legal, and a
 * *hostname claim* inside it must be one this organization may make.** Every
 * `traefik.{http,tcp}.routers.<n>.rule` is parsed, the `Host()`/`HostSNI()`
 * literals are extracted, and the caller checks each through
 * `DomainsService.assertHostsUnclaimed` — the rule `POST /domains` and
 * `POST /ai/deploy` already apply, reused rather than reimplemented. A
 * second ownership rule would be the H-20 shape: a writer that reaches the sink
 * around the guard.
 *
 * **This half is pure, and it refuses everything an ownership query could never
 * make safe:**
 *
 * - `HostRegexp`/`HostSNIRegexp`, which name a *pattern* and so cannot be owned
 *   at all. This is where the catalogue pays: **appwrite breaks**, because its
 *   rule is ``HostRegexp(`^.+\.${_APP_DOMAIN_SITES}$$`)`` — a claim on every
 *   subdomain of a shared ingress, which is the surface being closed rather
 *   than a casualty of closing it.
 * - a rule not **bounded** to a hostname: `PathPrefix(`/`)` alone matches every
 *   hostname reaching this Traefik, and so does the unbounded branch of a
 *   disjunction, and so does a negated host matcher.
 * - a rule this parser cannot **fully** read — an unknown matcher, unbalanced
 *   parentheses, a bare `${RULE}`. **A parser that fails open is not a guard**:
 *   that is H-74's lesson one chain-link back, where an unanchored `replace`
 *   returning its input unchanged became a phantom owner and leaked the platform
 *   container to every tenant.
 * - a host literal compose has still to **interpolate**. ``Host(`${DOMAIN}`)``
 *   is settled from the stack's env file on the build server, long after every
 *   check has run, so checking the pre-interpolation string would be checking a
 *   value Docker never sees. `VALID_HOSTNAME_REGEX` already excludes `$` and
 *   `{`; the interpolation case gets its own message because it is the likely
 *   one and "invalid domain name" would read as a typo.
 * - a wildcard in a hostname, for the reason `HostRegexp` is refused: it names a
 *   *set* of hostnames rather than one that can be owned.
 * - a `tls.domains` key this guard cannot read (H-85 — see
 *   {@link TLS_DOMAINS_FAMILY}), and every hostname one it *can* read names.
 * - a `com.docker.*` key, folded in here from `REFUSED_LABEL_NAMESPACES` (H-82's
 *   half of this chain on this path): those keys are how Cloudgate decides which
 *   organization owns a container, and unlike `traefik.*` **no compose file in
 *   the old `template.toml` catalogue wrote one**, so the namespace rule costs
 *   nothing here.
 *
 * **Why the same function is safe to run over already-converted content.**
 * `POST /compose/:id/start` runs the converted file already on disk, which
 * carries the injector's own router labels. Those pass: a generated rule is
 * ``Host(`<host>`)`` (optionally `&& (PathPrefix(`<path>/`) || Path(`<path>`))`,
 * see `traefik/config/path-rule.ts`) over a host that came
 * from this stack's own `domain` rows, and an ownership check that refuses only
 * *another* organization's claims and the console host admits them by
 * construction. So the guard needs no way to tell an author's label from a
 * generated one — which is worth stating, because the deploy path does give it
 * one for free (`writeDomainsToCompose` is handed the un-injected author content)
 * and a guard that depended on that would have been wrong at `start`.
 */

/**
 * The label namespaces refused on the compose path, selected from the shared
 * list by identity rather than restated (H-82 §*one list, read by both layers*).
 *
 * **Only the `com.docker` arm.** The traefik arm of that list is
 * `labelsSwarmSchema`'s, and applying it here would refuse four working
 * stacks — see the module docblock. Selection is deliberate and per
 * namespace: a third namespace added to the shared list will not silently start
 * refusing compose files, because whether it costs catalogue collateral is a
 * question only this path can answer. `compose-labels.spec.ts` pins that this
 * array is exactly the shared list's docker entry, so a rename over there fails
 * a test rather than dropping the rule.
 */
export const COMPOSE_REFUSED_LABEL_NAMESPACES = REFUSED_LABEL_NAMESPACES.filter(
  ({ pattern }) => pattern === DOCKER_LABEL_NAMESPACE,
);

/**
 * `traefik.{http,tcp}.routers.<name>.rule` — the only label whose *value* is a
 * routing rule. Matched case-insensitively because Traefik lowercases a label
 * key before matching its own prefixes, so `Traefik.HTTP.Routers.R.Rule` is the
 * same label to it and must be the same label here.
 */
const ROUTER_RULE_KEY = /^traefik\.(?:http|tcp)\.routers\.[^.]+\.rule$/i;

/**
 * `traefik.{http,tcp}.routers.<name>.tls.domains[<i>].{main,sans}` — a
 * **certificate** claim rather than a routing one (H-85).
 *
 * A router's rule decides what it answers for; this field decides what
 * Traefik asks Let's Encrypt for, and the two need not be the same hostname.
 * That is the whole finding: a caller the rule half has already **admitted** —
 * routing ``Host(`mine.example.com`)``, which is theirs — can add
 * `tls.certresolver=letsencrypt` and `tls.domains[0].main=victim.example.com`
 * and obtain a *valid* certificate for another tenant's hostname. The shipped
 * resolver uses `httpChallenge` on entrypoint `web`
 * (`deploy/traefik/traefik.yml.example`), which is this host's own port 80, and
 * on a shared ingress the victim's DNS already points here — so the challenge
 * passes. A certificate also outlives the container that asked for it.
 *
 * **Cloudgate writes this field nowhere.** `createComposeDomainLabels` mints
 * `tls.certresolver` and `tls=true` and nothing else, and the file provider's
 * side (`traefik/config/domain.ts:103-105`) writes `tls: { certResolver }` only.
 * So unlike the rule half there is no generated shape that has to be admitted,
 * and no compose file in the old `template.toml` catalogue set it either — the rule is
 * unconditional and costs zero collateral.
 *
 * `.sans` is a Traefik **slice**, comma-separated, so every element is its own
 * claim and each is checked. `[<i>]` is matched for any index rather than `0`
 * alone, because the slice is a slice.
 */
const TLS_DOMAINS_KEY =
  /^traefik\.(?:http|tcp)\.routers\.[^.]+\.tls\.domains\[\d+\]\.(?:main|sans)$/i;

/**
 * Anything in the `tls.domains` family, so a key this guard cannot read is
 * **refused rather than skipped**.
 *
 * Fail closed on the *key*, not only on the value. Without this, the guard's
 * coverage would depend on having predicted every spelling of the field, and a
 * misread key would silently claim nothing — which is exactly the shape H-74
 * closed one chain-link back, one level up from the value parser this file
 * already applies it to.
 *
 * The rule half needs no counterpart: a router name cannot contain a dot, so
 * `traefik.http.routers.a.b.rule` is read by Traefik as router `a` with an
 * unknown field `b.rule`, which leaves router `a` ruleless rather than routing
 * something this guard did not see.
 */
const TLS_DOMAINS_FAMILY = /^traefik\..*\.tls\.domains/i;

/** Matchers that bound a rule to a set of literal hostnames. */
const HOST_MATCHERS = new Set(['host', 'hostsni']);

/** Matchers that name a hostname *pattern*, which nobody can be said to own. */
const HOST_PATTERN_MATCHERS = new Set(['hostregexp', 'hostsniregexp']);

/**
 * Every other matcher `traefik:v3.6.7` has — the version pinned in
 * `settings/traefik-setup.service.ts` — none of which constrains the hostname.
 * The list is exhaustive on purpose: an unknown matcher is refused rather than
 * treated as one of these, because "a name I do not know" and "a name that does
 * not constrain the host" are different facts and only one of them is safe to
 * assume.
 */
const OTHER_MATCHERS = new Set([
  'header',
  'headers',
  'headerregexp',
  'headersregexp',
  'method',
  'path',
  'pathprefix',
  'pathregexp',
  'query',
  'queryregexp',
  'clientip',
  'alpn',
]);

/** A hostname a compose file's own labels claim, and the label that claims it. */
export type ComposeHostClaim = { host: string; label: string };

/**
 * A refusal from this guard. Distinguished from every other `Error` the emitter
 * can throw so a caller can answer it as a 400 naming the label, and so the
 * ownership half's `ConflictException` stays the separate answer it is.
 *
 * **`summary` is the same refusal said to a different audience, and it is
 * required rather than derived.** `message` quotes the operator's own
 * compose file back — always the label *key*, and for three of this file's
 * refusals the hostname value beside it — and `compose.composeFile` is
 * `encryptedText` (ADR 0015). That is fine for the audience the column
 * already has: a 400 to the caller who sent the bytes, or who owns the stack
 * they are stored on. It is not fine for the audience
 * `DeploymentEngineService.deployCompose` adds, whose `catch` hands one string
 * to a Deployment log *and* to `notifier.buildError` — email, mattermost,
 * telegram, pushover and a customer-supplied webhook.
 *
 * So every throw site states, in the type, what a third party may be told. It
 * is a required constructor argument and not an optional one, and not a
 * `summary ?? reason` default, because a default is how the next refusal added
 * here would leak: the compiler is the only thing that makes an author of a
 * *new* refusal answer ADR 0015's question. Where the reason quotes nothing —
 * the refused-namespace arm, the two `tls.domains` arms, the unbounded-rule arm
 * — the two strings are deliberately the same value rather than two spellings
 * of one sentence.
 *
 * `summary` names no label, and that is on ADR 0015's own terms rather than on
 * a judgement that a label key is harmless: the rule encrypts the whole body
 * *because* the platform cannot know which of its words are the secret, so a
 * key is not exempt for looking structural. What the audience keeps is
 * Cloudgate's own prose, which is the part an operator acts on.
 */
export class ComposeLabelRefusal extends Error {
  /** The refusal with nothing of the compose file in it. */
  readonly summary: string;

  constructor(label: string, reason: string, summary: string) {
    super(`Compose label "${label}" was refused: ${reason}`);
    this.name = 'ComposeLabelRefusal';
    this.summary = `A label in the compose file was refused: ${summary}`;
  }
}

// ---------------------------------------------------------------------------
// The rule expression parser.
//
// Traefik's grammar, and nothing more of it than the guard needs:
//
//   or      := and (('||') and)*
//   and     := unary (('&&') unary)*
//   unary   := '!' unary | '(' or ')' | matcher
//   matcher := IDENT '(' literal (',' literal)* ')'
//   literal := `backtick` | "double" | 'single'
//
// Anything the tokenizer or the parser cannot account for is a refusal, never a
// shrug: this parser's output decides whether a hostname gets checked, so a
// silent "no hosts found" on a rule it misread would be exactly the fail-open
// hole it exists to close.
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'ident'; value: string }
  | { kind: 'literal'; value: string }
  | { kind: 'punct'; value: '(' | ')' | ',' | '&&' | '||' | '!' };

const QUOTES = new Set(['`', '"', "'"]);

function tokenizeRule(rule: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < rule.length) {
    const char = rule[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (QUOTES.has(char)) {
      const end = rule.indexOf(char, index + 1);
      if (end === -1) throw new Error('unterminated literal');
      tokens.push({ kind: 'literal', value: rule.slice(index + 1, end) });
      index = end + 1;
      continue;
    }
    if (char === '&' || char === '|') {
      if (rule[index + 1] !== char) throw new Error(`stray "${char}"`);
      tokens.push({ kind: 'punct', value: char === '&' ? '&&' : '||' });
      index += 2;
      continue;
    }
    if (char === '(' || char === ')' || char === ',' || char === '!') {
      tokens.push({ kind: 'punct', value: char });
      index += 1;
      continue;
    }
    const ident = /^[A-Za-z][A-Za-z0-9_]*/.exec(rule.slice(index));
    if (!ident) throw new Error(`unexpected "${char}"`);
    tokens.push({ kind: 'ident', value: ident[0] });
    index += ident[0].length;
  }
  return tokens;
}

/**
 * The hostnames an expression can match, or `null` for "any hostname".
 *
 * `null` is the fail-closed value and the whole reason this is computed rather
 * than collected: a rule whose host set is unknown is refused, so every way of
 * *losing* a host constraint — a disjunct without one, a negation, a matcher
 * that says nothing about the host — has to widen to `null` rather than to an
 * empty list. An empty list would read as "claims nothing" and admit the rule.
 */
type HostSet = string[] | null;

function parseRuleHosts(rule: string): HostSet {
  const tokens = tokenizeRule(rule);
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const eat = (value: string): boolean => {
    const token = peek();
    if (token && token.kind === 'punct' && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };
  const expect = (value: string): void => {
    if (!eat(value)) throw new Error(`expected "${value}"`);
  };

  function parseMatcher(): HostSet {
    const token = peek();
    if (!token || token.kind !== 'ident') throw new Error('expected a matcher');
    position += 1;
    const name = token.value;
    expect('(');
    const args: string[] = [];
    do {
      const arg = peek();
      if (!arg || arg.kind !== 'literal') {
        throw new Error(`expected a quoted argument to ${name}`);
      }
      position += 1;
      args.push(arg.value);
    } while (eat(','));
    expect(')');

    const lowered = name.toLowerCase();
    if (HOST_PATTERN_MATCHERS.has(lowered)) {
      // Thrown rather than widened to `null`: "nobody can own a pattern" is a
      // more useful refusal than "this rule is not bounded to a hostname", and
      // it is the one an appwrite deploy will read.
      throw new PatternMatcherError(name);
    }
    if (HOST_MATCHERS.has(lowered)) return args;
    if (OTHER_MATCHERS.has(lowered)) return null;
    throw new UnknownMatcherError(name);
  }

  function parseUnary(): HostSet {
    if (eat('!')) {
      // The complement of a host constraint is every other hostname.
      parseUnary();
      return null;
    }
    if (eat('(')) {
      const inner = parseOr();
      expect(')');
      return inner;
    }
    return parseMatcher();
  }

  function parseAnd(): HostSet {
    let hosts = parseUnary();
    while (eat('&&')) {
      const right = parseUnary();
      // A conjunction can only narrow: whichever side is bounded is already a
      // superset of what the whole expression can match, so keeping it is sound
      // and keeping the left one is arbitrary but stable.
      hosts = hosts ?? right;
    }
    return hosts;
  }

  // `||` binds looser than `&&`, so a disjunction's operands are conjunctions.
  function parseOr(): HostSet {
    let hosts = parseAnd();
    while (eat('||')) {
      const right = parseAnd();
      // A disjunction widens: one branch that can match any hostname makes the
      // whole rule able to, which is the case that has to fail closed.
      hosts = hosts === null || right === null ? null : [...hosts, ...right];
    }
    return hosts;
  }

  const hosts = parseOr();
  if (position !== tokens.length) throw new Error('trailing input');
  return hosts;
}

/**
 * A rule naming `HostRegexp`/`HostSNIRegexp`: a pattern, not an ownable name.
 *
 * `summary` is the same sentence with the matcher name — a word of the
 * operator's own rule, and so a word of an `encryptedText` column — replaced by
 * its role. See {@link ComposeLabelRefusal}, which is what this becomes.
 */
class PatternMatcherError extends Error {
  readonly summary =
    'its routing rule names a hostname pattern rather than a hostname, and no organization can be said to own a pattern — route the stack through a Domain instead';

  constructor(readonly matcher: string) {
    super(
      `${matcher} names a hostname pattern rather than a hostname, and no organization can be said to own a pattern — route the stack through a Domain instead`,
    );
  }
}

/** A matcher `traefik:v3.6.7` does not have, or one this parser has not read. */
class UnknownMatcherError extends Error {
  readonly summary =
    'its routing rule names a matcher this guard cannot read, so the hostnames the rule can match cannot be established';

  constructor(readonly matcher: string) {
    super(
      `${matcher} is not a Traefik router matcher this guard can read, so the hostnames the rule can match cannot be established`,
    );
  }
}

/**
 * The three refusals whose prose quotes nothing of the compose file, hoisted so
 * that {@link ComposeLabelRefusal}'s two arguments are one value rather than
 * two spellings that can drift.
 */
const NAMES_NO_HOSTNAME =
  'it names no hostname, so there is nothing to check — remove the label or give it a hostname';

const UNREADABLE_TLS_SETTING =
  'it is a TLS certificate setting this guard cannot read, so the hostnames it would request a certificate for cannot be checked — the readable form is traefik.<http|tcp>.routers.<name>.tls.domains[<n>].<main|sans>';

const UNBOUNDED_RULE =
  'its routing rule is not bounded to a hostname, so it can answer for hostnames this organization does not own — add a Host() matcher, or route the stack through a Domain';

// ---------------------------------------------------------------------------
// Walking a compose spec's labels.
// ---------------------------------------------------------------------------

/** One label, from wherever in the file it was written. */
type LabelEntry = { key: string; value: string };

/**
 * A service's labels as `key`/`value` pairs, from list form *and* map form.
 *
 * Both forms, because compose accepts both and only one of them is a form
 * `addDomainsToComposeSpec` writes into. That it never rewrites the map form
 * means Cloudgate writes nothing there — not that nothing gets there: an
 * author's labels in a map reach the container exactly the same way, so an
 * array-only guard would have shipped with a bypass in the same file.
 */
function labelEntries(labels: ComposeLabels | undefined): LabelEntry[] {
  if (!labels) return [];
  if (Array.isArray(labels)) {
    return labels.map((entry) => {
      const line = String(entry);
      const separator = line.indexOf('=');
      return separator === -1
        ? { key: line, value: '' }
        : {
            key: line.slice(0, separator),
            value: line.slice(separator + 1),
          };
    });
  }
  return Object.entries(labels).map(([key, value]) => ({
    key,
    value: value === null || value === undefined ? '' : String(value),
  }));
}

/**
 * Every label in the spec: both forms, both places, every service.
 *
 * `deploy.labels` is read for a `docker-compose` stack as well as a `stack` one.
 * Docker Compose ignores it there, so reading it refuses a label that would
 * never have been honoured — which is the right direction to be wrong in, and
 * cheaper than making the guard depend on a `composeType` the author can change
 * with a `PATCH` that omits `composeFile`.
 */
function allLabelEntries(spec: ComposeSpecification): LabelEntry[] {
  const services: ComposeServiceSpec[] = Object.values(spec.services ?? {});
  return services.flatMap((service) => [
    ...labelEntries(service?.labels),
    ...labelEntries(service?.deploy?.labels),
  ]);
}

// ---------------------------------------------------------------------------
// The guard.
// ---------------------------------------------------------------------------

/**
 * Every hostname the compose content's own labels claim — refusing, on the way,
 * every label no ownership query could make safe (see the module docblock).
 *
 * Throws {@link ComposeLabelRefusal}. Returns `[]` for content that claims
 * nothing, and for `null` — content that is not a compose file at all: the
 * empty-file and not-a-spec refusals belong to `parseComposeFileOrThrow`, and a
 * second message for them here would change which error the Converted tab shows.
 *
 * Takes a **spec** rather than content, and `compose.utils.ts` owns the
 * content-taking wrapper, so that this module imports nothing from the file that
 * imports it. The alternative — a second `parse(content, { maxAliasCount })`
 * here — would be two readings of a compose file's bytes, which is the shape
 * §1.4 is about.
 */
/**
 * One hostname a label claims, normalized and checked — or a refusal.
 *
 * Shared by the routing half and the certificate half so the two cannot drift
 * on what counts as a hostname. All three refusals are the same statement in
 * three places: **the value checked has to be the value Docker sees.**
 */
function checkedClaim(label: string, raw: string): ComposeHostClaim {
  // Lowercased and trimmed to match `assertHostUnclaimed`, which compares
  // `lower(domain.host)`: DNS, Traefik's Host matcher and a certificate's
  // subject are all case-blind, so an exact comparison would leave the
  // ownership rule one `.toUpperCase()` away from a bypass.
  const host = raw.trim().toLowerCase();
  if (host.includes('$')) {
    throw new ComposeLabelRefusal(
      label,
      `the hostname "${raw}" is interpolated by compose on the build server, after this check has run, so the value Docker would see cannot be checked here`,
      'the hostname it names is interpolated by compose on the build server, after this check has run, so the value Docker would see cannot be checked here',
    );
  }
  if (host.includes('*')) {
    // The `HostRegexp` case, one field over: a wildcard names a *set* of
    // hostnames, and no organization can be said to own a set. It matters more
    // here than in a rule, where Traefik's `Host` matcher has no wildcard
    // semantics anyway — `tls.domains` does, and `*.example.com` is a real
    // wildcard-certificate request.
    throw new ComposeLabelRefusal(
      label,
      `the hostname "${raw}" is a wildcard, which names a set of hostnames rather than one this organization can be said to own — name each hostname, or route the stack through a Domain`,
      'the hostname it names is a wildcard, which names a set of hostnames rather than one this organization can be said to own — name each hostname, or route the stack through a Domain',
    );
  }
  if (!VALID_HOSTNAME_REGEX.test(host)) {
    throw new ComposeLabelRefusal(
      label,
      `the hostname "${raw}" is not a hostname. ${INVALID_HOSTNAME_MESSAGE}`,
      `the hostname it names is not a hostname. ${INVALID_HOSTNAME_MESSAGE}`,
    );
  }
  return { host, label };
}

export function readComposeHostClaimsFromSpec(
  spec: ComposeSpecification | null,
): ComposeHostClaim[] {
  if (!spec) return [];
  const claims: ComposeHostClaim[] = [];

  for (const { key, value } of allLabelEntries(spec)) {
    for (const { pattern, message } of COMPOSE_REFUSED_LABEL_NAMESPACES) {
      // `message` comes off `REFUSED_LABEL_NAMESPACES` and quotes nothing, so
      // the two audiences get the same sentence.
      if (pattern.test(key))
        throw new ComposeLabelRefusal(key, message, message);
    }

    // The certificate half (H-85), before the routing half because its keys are
    // longer and neither pattern can match the other.
    if (TLS_DOMAINS_KEY.test(key)) {
      // `.sans` is a Traefik slice; `.main` is one value, which is the
      // degenerate one-element case of the same split rather than a second path.
      const named = value
        .split(',')
        .map((element) => element.trim())
        .filter((element) => element !== '');
      if (named.length === 0) {
        throw new ComposeLabelRefusal(
          key,
          NAMES_NO_HOSTNAME,
          NAMES_NO_HOSTNAME,
        );
      }
      for (const element of named) claims.push(checkedClaim(key, element));
      continue;
    }
    if (TLS_DOMAINS_FAMILY.test(key)) {
      throw new ComposeLabelRefusal(
        key,
        UNREADABLE_TLS_SETTING,
        UNREADABLE_TLS_SETTING,
      );
    }

    if (!ROUTER_RULE_KEY.test(key)) continue;

    let hosts: HostSet;
    try {
      hosts = parseRuleHosts(value);
    } catch (error) {
      if (
        error instanceof PatternMatcherError ||
        error instanceof UnknownMatcherError
      ) {
        // Both quote the *matcher name*, which is a word of the operator's own
        // rule, so each carries its own byte-free form.
        throw new ComposeLabelRefusal(key, error.message, error.summary);
      }
      throw new ComposeLabelRefusal(
        key,
        `its routing rule could not be parsed, so the hostnames it can match cannot be checked (${
          (error as Error).message
        })`,
        // The tokenizer's own messages name the offending character or
        // identifier (`stray "&"`, `unexpected "@"`), so the parenthetical goes
        // rather than being reworded.
        'its routing rule could not be parsed, so the hostnames it can match cannot be checked',
      );
    }

    // `hosts.length === 0` is defensive and **no test can turn it red**: a host
    // matcher's argument list is parsed with a `do`/`while`, so it always has at
    // least one entry, and neither `&&` nor `||` can produce an empty list from
    // non-empty ones. It is written anyway because an empty list would read as
    // "this rule claims nothing" and be *admitted*, which is the one way this
    // function could fail open — the same reason `HostSet`'s unbounded value is
    // `null` rather than `[]`.
    if (hosts === null || hosts.length === 0) {
      throw new ComposeLabelRefusal(key, UNBOUNDED_RULE, UNBOUNDED_RULE);
    }

    for (const raw of hosts) {
      claims.push(checkedClaim(key, raw));
    }
  }

  return claims;
}
