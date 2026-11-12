import { dirname, join } from 'node:path';
import { stackRootId } from './stack-root';
import { parse as parseEnv } from 'dotenv';
import { quote } from 'shell-quote';
import { stringify, YAMLParseError } from 'yaml';
import {
  applyComposeDefaults,
  composeDotenvLine,
  parseComposeFile,
} from './compose-file';
import {
  presenceProbeCommand,
  readWorkloadPresence,
} from '../common/workload-presence';
import type { WorkloadPresence } from '../common/workload-presence';
import { composeDirectoryOn } from '../deployment-engine/deployment-engine.paths';
import { withVolumeLock } from '../deployment-engine/volume-lock';
import {
  encodeBase64,
  getEnvironmentVariablesObject,
  prepareEnvironmentVariables,
} from '../docker/docker.utils';
import { capMessage } from '../notifications/channels/cap-message';
import { CLOUDGATE_AI_NETWORK } from '../ai-models/ai-network';
import { AI_NETWORK_MESSAGE } from '../applications/swarm.types';
import { CLOUDGATE_NETWORK } from '../servers/server-audit';
import {
  composeDomainEntrypoints,
  composeRouterName,
  composeStackConfigName,
} from '../traefik/config/names';
import { injectComposeTraceWiring } from '../traces/compose-trace-wiring';
import type { ComposeTraceWiring } from '../traces/compose-trace-wiring';
import { ensureTraceStoreNetworkCommand } from '../traces/trace-store';
import { createComposeStackTraefikConfig } from '../traefik/config/compose-stack';
import { pathRuleClause } from '../traefik/config/path-rule';
import { dynamicTraefikConfigPath } from '../traefik/traefik-writer.service';
import {
  ComposeLabelRefusal,
  readComposeHostClaimsFromSpec,
} from './compose-labels';
import type { ComposeHostClaim } from './compose-labels';
import type {
  ComposeDomain,
  ComposeLabels,
  ComposeServiceNetworks,
  ComposeServiceSpec,
  ComposeSpecification,
  ComposeSpecSource,
  DeployableComposeSource,
} from './compose.types';

// The pure part moved to `compose-file.ts`, which the CLI bundles; it is
// still read from here by everything that read it before.
export {
  applyComposeDefaults,
  DEFAULT_COMPOSE_RESTART,
  listComposePublishedPorts,
  parseComposeFile,
} from './compose-file';
export type { ComposePublishedPort } from './compose-file';

/**
 * How much of the YAML library's own words a parse refusal repeats.
 *
 * 500 code units is the limit settled for a third party's message and the
 * reasoning transfers unchanged: the words stay, because an operator who pasted
 * broken YAML acts on *what* the parser objected to, and only the *length* is
 * not load-bearing. `capMessage` is imported rather than reimplemented for
 * H-122's reason — nine copies of that `substring` were each written the same
 * wrong way, and a lone surrogate at the cut survives JSON but not a receiver
 * that re-encodes the field. Its home is arguably `common/`; that was recorded
 * rather than moving it and this call site does not change the answer.
 *
 * **The cap is load-bearing rather than defensive, and it is load-bearing for
 * both arms.** `Unresolved alias (the anchor must be set before the alias):
 * ${name}` interpolates the alias name, which is the caller's own bytes with no
 * length bound of its own — a compose file may name a 100 KB anchor.
 *
 * **This paragraph used to end by exempting the other arm — *"the two
 * `YAMLParseError` shapes are bounded by the library's own vocabulary and would
 * not have needed this"* — and that was false.** `yaml` has no
 * such vocabulary: several of its base messages interpolate a slice of the
 * document, and a base message is precisely the part
 * {@link boundUpstreamYamlMessage} keeps, because it is what sits before the
 * first newline. Measured against the installed **2.9.0**, each with a 907-byte
 * token in the file and each arriving as a `YAMLParseError` through
 * {@link parseComposeFile}'s own options:
 *
 * - `Block scalar header includes extra characters: ${source}`
 *   (`resolve-block-scalar.js`, `UNEXPECTED_TOKEN`) — 977 code units of first
 *   line, the whole header token verbatim.
 * - `Could not resolve tag: ${source}` (`doc/directives.js`,
 *   `TAG_RESOLVE_FAILED`) — 954, the tag token verbatim.
 * - `The ${source} tag has no suffix` (same file, same code) — 952.
 *
 * Two more interpolate the document but are bounded by their own shape rather
 * than by a vocabulary: `Plain value cannot start with reserved character
 * ${badChar}` is one character, and `Invalid escape sequence ${raw}` is two.
 *
 * **Two of the three named examples do not survive the measurement**, and
 * they are recorded as not-reachable so the list above is not widened back on
 * the strength of a grep. `Not a valid tag: ${source}` sits behind
 * `source[0] !== '!'` in `Directives.tagName`, and the lexer emits a `tag`
 * token only for a source that starts with `!` — `!!!<token>` arrives as
 * `Could not resolve tag:` instead. And `Unexpected ${token.source} in
 * ${flow}` (`resolve-props.js`) reads an *indicator* token's source, which is
 * one of `-`, `?` and `:`; that one genuinely is bounded by the library's
 * grammar, which is the claim this docblock was making about all of them.
 *
 * `compose-file-parseable.spec.ts` holds the three above with expectations
 * built from the library's own uncapped message, so a case goes red if either
 * the interpolation stops or the cap does.
 *
 * The first line **only**, which is the part that matters more than the cap.
 * `yaml` prettifies a `YAMLParseError` into the sentence, then a blank line,
 * then the failing line of the document with a caret under it — so the message
 * quotes the compose file back. That is fine for the DTO paths, where the caller
 * sent the bytes, and not fine for the other three:
 * {@link readComposeHostClaims}' caller also reads the stored column, a file
 * `cat`'d back off the Server, and a cloned repository, and
 * `deployment-engine.service.ts`' `appendErrorToLog` and `buildError` put
 * `error.message` into a Deployment log and into a build-failure notification —
 * Discord, Telegram, a customer's webhook. A compose file carries inline
 * environment values, so the caret diagram is a path from `MARIADB_ROOT_PASSWORD`
 * to a third party. The `line`/`column` the sentence ends with survive, and they
 * are what an operator navigates by.
 *
 * The console's own editor check (`yaml-check.ts`' `yamlProblem`) reached the
 * same shape independently and by driving it — same parser, same
 * `maxAliasCount`, first line only, trailing colon stripped — which is why the
 * two agree about *which* files are refusable. It was the only thing enforcing
 * this until now, so the copy under its editor ("it is not saved until this is
 * fixed") is true of the API rather than of the screen alone. It does
 * not make the alias/syntax distinction below and calls both "not valid YAML";
 * that is a wording difference on one screen, not a difference in what is
 * refused, and narrowing it is recorded rather than done here.
 */
const UPSTREAM_YAML_MESSAGE_LIMIT = 500;

/** The library's sentence, first line only and capped. */
function boundUpstreamYamlMessage(message: string): string {
  // The trailing `:` goes with the snippet it introduces — `… at line 1,
  // column 20:` reads as a truncation once nothing follows it. An error the
  // library raised without a `linePos` has no snippet and no colon, so this is
  // a strip rather than a slice.
  const sentence = message.split('\n')[0].replace(/:$/, '');
  const capped = capMessage(sentence, UPSTREAM_YAML_MESSAGE_LIMIT);
  return capped === sentence ? sentence : `${capped}…`;
}

/**
 * How much of the operator's own compose file a refusal may quote back.
 *
 * ADR 0015's echo bullet asks two questions of every echo — *who can see it,
 * and is that the audience the column already has* — and the compose refusals
 * are the first place in this tree where one refusal has two answers. A 400 to
 * the caller who sent the bytes, or who owns the stack they are stored on, is
 * the audience `compose.composeFile` already has: `'verbatim'`. The
 * build-failure notification `DeploymentEngineService.deployCompose` sends is
 * not — it reaches email, mattermost, telegram, pushover and a
 * **customer-supplied webhook**: `'summary'`.
 *
 * **A parameter rather than two functions**, because the alternative is two
 * readings of the same rule, which is what §2.4 and the content guard's own *"there is one
 * function and it is this one"* exist to prevent. The refusal is one rule; only
 * its audience varies.
 */
export type ComposeRefusalEcho = 'verbatim' | 'summary';

/**
 * The position `yaml` gave a parse failure, said without quoting the document.
 *
 * A line and a column are the one part of the library's sentence that is *not*
 * the operator's bytes, and it is already recorded that they are "what an
 * operator navigates by". So they are what survives into a summary: the
 * notification says which line to open, and the file itself says what is on it.
 *
 * Read off `YAMLParseError.linePos` rather than by regex over the sentence,
 * because the sentence is the thing being withheld — parsing a position back
 * out of a string that must not be forwarded is a way to forward it by
 * accident. `linePos` is set by the library's own `prettifyError`, which `parse`
 * runs before it throws; `undefined` for an error raised without a source
 * position, which is why this returns `''` rather than inventing one.
 */
function yamlPosition(error: unknown): string {
  const at = (error as { linePos?: [{ line: number; col: number }] }).linePos;
  const first = at?.[0];
  return first ? ` at line ${first.line}, column ${first.col}` : '';
}

/**
 * The audience-safe form of a refusal this module raised, or `null` for an
 * error that quotes nothing of the compose file.
 *
 * One function, so that the two seams a deploy passes through —
 * {@link writeDomainsToCompose} for a raw stack and
 * `ComposeService.assertComposeContentClaimable` for every stack — cannot
 * disagree about what a third party is told. `null` rather than a fallback
 * sentence: an error this does not recognise is not this rule's to reword, and
 * the two domain-injection refusals `addDomainsToComposeSpec` raises quote
 * `domain.host` and `domain.serviceName` — `domain` rows, not the encrypted
 * column — so they are deliberately left alone.
 */
export function composeContentRefusalSummary(error: unknown): string | null {
  if (error instanceof YAMLParseError) {
    return `Compose file is not valid YAML${yamlPosition(error)}`;
  }
  if (error instanceof ReferenceError) {
    // No position: `Alias.resolve` throws during the `toJS` half, past the
    // point where the library attaches one. The alias *name* is the whole of
    // what the verbatim message adds, and the name is the operator's bytes.
    return "Compose file's YAML aliases cannot be resolved";
  }
  if (error instanceof ComposeLabelRefusal) return error.summary;
  return null;
}

/**
 * The refusal a compose file `parse` will not read earns, or `null` for content
 * it reads — the shape a zod `superRefine` needs, and the one entry point both
 * halves of the rule use.
 *
 * **What broke.** `readComposeHostClaims` calls {@link parseComposeFile}
 * unguarded, so a parse failure escaped
 * `ComposeService.assertComposeContentClaimable` — a guard whose docblock
 * documents a 400 and a 409 — and `AllExceptionsFilter` rendered it as a 500 on
 * `POST /compose`, `PATCH /compose/:id`, `POST /compose/:id/start`,
 * `createByTemplate`'s caller and the deployment engine's pre-flight.
 * `composeFile` was a bare `z.string()` on both compose DTOs and `dockerCompose`
 * one on `deployAiSchema`, so nothing upstream refused it either.
 *
 * **`parse` does not raise one class, and the first cut of this guard assumed it did.**
 * The reachable set for caller-supplied content is exactly two:
 *
 * - `YAMLParseError` — every syntax and composition failure. A stack overflow on
 *   a deeply nested document is in here too: the library catches the `RangeError`
 *   and re-raises it as `Maximum call stack size exceeded at line N, column M`.
 * - `ReferenceError` — from {@link https://github.com/eemeli/yaml | yaml}'s
 *   `Alias.resolve`, during the `toJS` half of `parse`. Two of its four throws
 *   are reachable: an alias whose anchor is never set (`*base` with no `&base`),
 *   and `maxAliasCount` exceeded. The other two need `maxAliasCount === 0`,
 *   which {@link parseComposeFile} never passes, or are the library's own
 *   `istanbul ignore` invariant.
 *
 * A `ReferenceError` is **not** a `YAMLError`, so an `instanceof YAMLParseError`
 * arm re-threw it — leaving the 500 in place for the alias bomb, which is the one
 * input class here that is deliberately hostile rather than merely broken, and
 * for the ordinary unset-anchor typo alongside it. `YAMLWarning` is not in the
 * set either, and **the reason this sentence used to give was wrong.** It said
 * an unresolved *tag* goes to `process.emitWarning` and `parse` answers
 * normally — true, and it reads as harmless, which it was not: that call
 * reached process stderr carrying a prettified line of the caller's own
 * document, and that was closed at {@link parseComposeFile}'s `logLevel`. What
 * holds the class out of *this* function's business is only that it never
 * becomes a throw, so there was never anything here to convert. Nor are
 * `stringify`'s and yaml-1.1 `!!pairs`/`!!omap`'s `TypeError`s — the composer
 * refuses those shapes as a `YAMLParseError` first.
 *
 * **A class outside the set stays a throw**, deliberately: a blanket `catch`
 * would render a future bug in this module as a 400 blaming the operator's file
 * for it. What makes that safe to promise is that the `try` below wraps exactly
 * one call — `parse`, and nothing of Cloudgate's. `readComposeHostClaimsFromSpec`
 * is outside it by construction rather than by an error-class enumeration, which
 * is why `assertComposeContentClaimable` calls this ahead of
 * {@link readComposeHostClaims} rather than widening its own `catch`. The cost is
 * one extra `parse` of content that is about to be parsed again, and it is
 * already inside the budget: `ComposeService.update` parses the same content once
 * per Domain row of the stack through `composeServiceUsesMapFormLabels`.
 *
 * **The two sentences are two sentences on purpose.** A syntax error is *"not
 * valid YAML"*; an alias bomb is not — `yamllint` passes it, and the file is
 * refused for what it expands to rather than for how it reads. Telling that
 * operator their YAML is invalid sends them hunting a typo that is not there, and
 * §2.5 asks a message to say what is wrong. The remediations differ too: fix the
 * syntax, define the anchor, or stop using ten thousand aliases.
 *
 * **This rule is applied in two places**, which §2.4 otherwise exists to prevent.
 * The DTO is the right home for the request paths — a `composeFile` that will not
 * parse is a shape violation, answered 400 at a field path — but
 * `assertComposeContentClaimable` is also asked about content no DTO ever saw:
 * the stored column on a `.partial()` PATCH that names other fields, the file
 * `readClaimableOnDiskCompose` reads back off the Server, and the cloned
 * repository that is the *only* seam a git-sourced stack's file is visible at.
 * Deleting either half leaves a reachable 500. What keeps them from drifting is
 * that there is one function and it is this one.
 *
 * Rejected: **failing open** the way {@link composeServiceUsesMapFormLabels}
 * does. That neighbour is a *predicate* answering "does this service use map
 * labels", and fail-open was chosen for it deliberately — every input it cannot
 * read is already some other guard's refusal, and a pre-flight that grew new
 * ones would be a second rule riding inside it. This is a *guard*, and the
 * asymmetry is the point: a guard that cannot read its input has not admitted
 * it. Fail-open here would store content nothing can deploy and defer the
 * complaint to a screen the operator did not break it on.
 */
export function composeFileParseRefusal(
  content: string,
  echo: ComposeRefusalEcho = 'verbatim',
): string | null {
  try {
    parseComposeFile(content);
    return null;
  } catch (error) {
    // `'verbatim'` is the default here and `'summary'` is the default at
    // `assertComposeContentClaimable`, and the asymmetry is deliberate: this
    // function's own default consumer is `composeFileSchema`, whose audience is
    // by construction the caller who sent the bytes, while that method's is a
    // deploy in another module whose call site this change may not edit. Each
    // default is the safe answer for the callers that do not pass one.
    if (echo === 'summary') {
      const summary = composeContentRefusalSummary(error);
      if (summary !== null) return summary;
      throw error;
    }
    if (error instanceof YAMLParseError) {
      return `Compose file is not valid YAML: ${boundUpstreamYamlMessage(error.message)}`;
    }
    if (error instanceof ReferenceError) {
      return `Compose file's YAML aliases cannot be resolved: ${boundUpstreamYamlMessage(error.message)}`;
    }
    throw error;
  }
}

/**
 * The refusal of a compose file that names `cloudgate-ai`, or `null`.
 *
 * A Compose has no `networkSwarm`; its file is where it names networks. A
 * root network keyed or `name:`d `cloudgate-ai` (the `external: true` form is
 * how a stack would join the real overlay, the others would only borrow the
 * name) and a service's `network_mode: cloudgate-ai` are each refused, for
 * {@link AI_NETWORK_MESSAGE}'s reason. Content that does not parse is
 * {@link composeFileParseRefusal}'s to answer, so it is `null` here.
 */
export function composeAiNetworkRefusal(content: string): string | null {
  let spec: ComposeSpecification | null;
  try {
    spec = parseComposeFile(content);
  } catch {
    return null;
  }
  if (!spec || typeof spec !== 'object') return null;
  const named = (value: unknown): boolean => value === CLOUDGATE_AI_NETWORK;
  const rootNames = Object.entries(spec.networks ?? {}).some(
    ([key, network]) =>
      named(key) ||
      named(network?.name) ||
      (typeof network?.external === 'object' &&
        named((network.external as { name?: unknown } | null)?.name)),
  );
  const modeNames = Object.values(spec.services ?? {}).some((service) =>
    named((service as ComposeServiceSpec | null)?.network_mode),
  );
  return rootNames || modeNames
    ? `${AI_NETWORK_MESSAGE}. Remove it from the compose file`
    : null;
}

/**
 * `parseComposeFile` with the two rejections every deploy path depends on: a
 * file that parses to nothing, and a document that names nothing to bring up.
 * One helper rather than four inline throws so the message stays one message:
 * `compose.service.ts` turns it into a 400 for the Converted tab, and
 * `deployment-engine.service.ts` relies on it firing *before* the clone's
 * `rm -rf` has touched the target.
 *
 * **The second rejection is an empty document.** `volumes: {}` parses, so it passed here,
 * the clone wrote it over the project file the running containers came from,
 * and Docker answered `no service selected` — a sentence naming neither the
 * file nor the cause, on a stack whose directory no longer described what was
 * running. The refusal is the same shape as the empty-file one and lands in the
 * same place: in front of the first write, so the target keeps the
 * deploy it is serving and `composeStatus` is left alone.
 *
 * It is deliberately **not** in `composeFileSchema`, so saving such a file
 * stays legal. Empty already is — a stack is created before its file is written
 * — and a file whose services are still to come is the same half-written state
 * one keystroke later; the refusal an operator needs is the one at the moment
 * the platform would act on it.
 */
function parseComposeFileOrThrow(content: string): ComposeSpecification {
  const spec = parseComposeFile(content);
  if (!spec) {
    throw new Error('Compose file is empty');
  }
  if (!declaresSomethingToDeploy(spec)) {
    throw new Error(
      'The compose file declares no services, so there is nothing to deploy',
    );
  }
  return spec;
}

/**
 * Whether a parsed document names anything Docker could bring up.
 *
 * `include:` counts and is not a nicety: Compose resolves an included file's
 * services as if they were written here, so a git-sourced stack whose file is
 * nothing but an `include:` list deploys exactly as many services as its author
 * intended — and refusing it would be this guard inventing a rule Docker does
 * not have. A raw stack cannot use it in practice (its file is written alone
 * into the project directory, with nothing beside it to include), which is why
 * the key is admitted rather than resolved: what it points at is the deploy's
 * question, and this one only has to stop short of calling it empty.
 */
function declaresSomethingToDeploy(spec: ComposeSpecification): boolean {
  if (Object.keys(spec.services ?? {}).length > 0) return true;
  return spec.include != null;
}

/**
 * Every hostname a compose file's own Traefik labels claim, refusing on the way
 * every label no ownership query could make safe (H-83 — see
 * `compose-labels.ts`, which owns the rule).
 *
 * The wrapper lives here rather than beside the rule so that `compose-labels.ts`
 * imports nothing from this file, which imports it. Callers that hold an
 * organization id feed the result to `DomainsService.assertHostsUnclaimed`; the
 * pure half runs unconditionally at {@link writeDomainsToCompose} below.
 */
export function readComposeHostClaims(content: string): ComposeHostClaim[] {
  return readComposeHostClaimsFromSpec(parseComposeFile(content));
}

/** The service names a compose file defines. */
export function listComposeServices(content: string): string[] {
  const spec = parseComposeFile(content);
  return Object.keys(spec?.services ?? {});
}

/**
 * The volumes a `docker-compose` stack's Delete removes, as Docker names
 * them: each one the file declares under its top-level `volumes:`, which
 * `docker compose down --volumes` removes — `<appName>_<key>`, or the
 * `name:` it gives — and never an `external` one, which compose leaves.
 * A `stack` is torn down by `docker stack rm`, which removes no volume, so
 * it has none. A file that does not parse declares none.
 *
 * Read from the file a deploy admitted and recorded on the row
 * (`compose.deployedVolumes`), so a plan's destroy line names them
 * without the plan reading a compose file (ADR-0069).
 */
export function listComposeVolumes(
  content: string,
  appName: string,
  composeType: 'docker-compose' | 'stack',
): string[] {
  if (composeType === 'stack') return [];
  let spec: ComposeSpecification | null;
  try {
    spec = parseComposeFile(content);
  } catch {
    return [];
  }
  const volumes = spec?.volumes;
  if (!volumes || typeof volumes !== 'object') return [];
  const names: string[] = [];
  for (const [key, definition] of Object.entries(volumes)) {
    const declared =
      definition && typeof definition === 'object'
        ? (definition as Record<string, unknown>)
        : {};
    if (declared.external) continue;
    names.push(
      typeof declared.name === 'string' && declared.name !== ''
        ? declared.name
        : `${appName}_${key}`,
    );
  }
  return names;
}

// The compose-label variant of Traefik routing (the traefik module's
// generators build the file-provider equivalent). Router names are
// `composeRouterName`'s, `${appName}-${uniqueConfigKey}-${entrypoint}`.
export function createComposeDomainLabels(
  appName: string,
  domain: ComposeDomain,
  entrypoint: string,
): string[] {
  const {
    host,
    port,
    customEntrypoint,
    https,
    uniqueConfigKey,
    certificateType,
    path,
    customCertResolver,
    stripPath,
    internalPath,
  } = domain;
  const routerName = composeRouterName(appName, uniqueConfigKey, entrypoint);
  const labels = [
    `traefik.http.routers.${routerName}.rule=Host(\`${host}\`)${pathRuleClause(path)}`,
    `traefik.http.routers.${routerName}.entrypoints=${entrypoint}`,
    `traefik.http.services.${routerName}.loadbalancer.server.port=${port ?? 80}`,
    `traefik.http.routers.${routerName}.service=${routerName}`,
  ];

  const middlewares: string[] = [];
  // A web router in front of an https domain only redirects — every other
  // middleware runs on the websecure router where the request lands.
  const isRedirectRouter = entrypoint === 'web' && https && !customEntrypoint;
  if (isRedirectRouter) {
    middlewares.push('redirect-to-https@file');
  }

  if (stripPath && path && path !== '/') {
    const middlewareName = `stripprefix-${appName}-${uniqueConfigKey}`;
    // Define the middleware on the web (or custom) entrypoint so Traefik
    // registers it exactly once.
    if (entrypoint === 'web' || customEntrypoint) {
      labels.push(
        `traefik.http.middlewares.${middlewareName}.stripprefix.prefixes=${path}`,
      );
    }
    if (!isRedirectRouter) {
      middlewares.push(middlewareName);
    }
  }

  if (internalPath && internalPath !== '/' && internalPath.startsWith('/')) {
    const middlewareName = `addprefix-${appName}-${uniqueConfigKey}`;
    if (entrypoint === 'web' || customEntrypoint) {
      labels.push(
        `traefik.http.middlewares.${middlewareName}.addprefix.prefix=${internalPath}`,
      );
    }
    if (!isRedirectRouter) {
      middlewares.push(middlewareName);
    }
  }

  if (!isRedirectRouter && domain.middlewares?.length) {
    middlewares.push(...domain.middlewares);
  }

  if (middlewares.length > 0) {
    labels.push(
      `traefik.http.routers.${routerName}.middlewares=${middlewares.join(',')}`,
    );
  }

  if (entrypoint === 'websecure' || (customEntrypoint && https)) {
    if (certificateType === 'letsencrypt') {
      labels.push(
        `traefik.http.routers.${routerName}.tls.certresolver=letsencrypt`,
      );
    } else if (certificateType === 'custom' && customCertResolver) {
      labels.push(
        `traefik.http.routers.${routerName}.tls.certresolver=${customCertResolver}`,
      );
    } else if (
      (certificateType === 'none' || certificateType === 'stored') &&
      https
    ) {
      // No cert resolver but https requested (a certificate from Settings →
      // Certificates, or Traefik's default): enable TLS explicitly so
      // Traefik serves the router over https.
      labels.push(`traefik.http.routers.${routerName}.tls=true`);
    }
  }

  return labels;
}

/**
 * Where a compose service of this flavour declares the labels Cloudgate injects
 * into — Compose's own key name, quoted in a refusal so the operator knows
 * which block to rewrite. Only a `docker-compose` Compose is injected into,
 * and it reads `labels`; `deploy.labels` is kept for a caller that
 * still asks about a stack, which no refusal reaches any more.
 */
const labelsKeyFor = (composeType: ComposeSpecSource['composeType']): string =>
  composeType === 'docker-compose' ? 'labels' : 'deploy.labels';

/**
 * The one sentence Cloudgate answers with when a routed compose service
 * declares its labels as a **map** rather than a list.
 *
 * **There is no third option, converting the map.** The injector only ever
 * appends to a list, and converting the map to a list before injecting would
 * change the author's own file shape, which this module avoids everywhere
 * (`applyComposeDefaults`' `??=`). What was filed is not the skip;
 * it is that the skip was **silent** while the rest of
 * {@link addDomainsToComposeSpec} carried on joining the service to the routed
 * network and declaring that network external at the root. The operator got a
 * success, a Converted tab showing network wiring that reads as configured, and
 * no Traefik router anywhere — the failure mode named one schema over: a
 * refusal is the only one of the three shapes where the operator learns.
 *
 * One builder rather than a sentence at each seam, because two seams answer with
 * it — {@link addDomainsToComposeSpec}'s own throw and
 * `DomainsService.assertComposeServiceRoutable`, the attach-time pre-flight —
 * and §1.4's rule is one rule applied at the extra seam that sees the value
 * early, never a second spelling of it. It names Compose's `labels` /
 * `deploy.labels` key rather than the glossary's Service, because the subject is
 * a service *inside* the file: a third-party string, which §1.1 keeps under its
 * own name, and the shape the two sibling throws below already use.
 */
export function mapFormLabelsRefusal(
  composeType: ComposeSpecSource['composeType'],
  host: string,
  serviceName: string,
): string {
  return `Domain "${host}" is attached to service "${serviceName}", which declares "${labelsKeyFor(composeType)}" as a map — Cloudgate adds Traefik routing labels only to the list form. Rewrite that service's labels as a list of "key=value" entries, or attach this domain to a service that already uses one`;
}

/**
 * Whether the service a domain names declares its labels in the map form
 * {@link mapFormLabelsRefusal} refuses — the pre-flight half, for a caller that
 * holds the file *before* {@link addDomainsToComposeSpec} would run.
 *
 * **It fails open on everything it cannot read, deliberately**, and the
 * injector's own throw stays the authority. An empty `composeFile` column, YAML
 * that does not parse, a `services:` block this content does not have, and a
 * `serviceName` the file does not declare all answer `false` — every one of them
 * is a condition some other guard already owns (`parseComposeFileOrThrow`'s
 * empty-file throw, the injector's unknown-service throw) and none of them is a
 * refusal `POST /domains` has ever made. A pre-flight that started refusing them
 * would be a new rule riding inside this one, which is the shape the ownership
 * check's own residual list warns off.
 */
export function composeServiceUsesMapFormLabels(
  composeType: ComposeSpecSource['composeType'],
  content: string,
  serviceName: string,
): boolean {
  let spec: ComposeSpecification | null;
  try {
    spec = parseComposeFile(content);
  } catch {
    return false;
  }
  // A stack gets no labels at all — its Domains are routed by the
  // file provider — so the form of its `deploy.labels` is nobody's business.
  if (composeType !== 'docker-compose') return false;
  const service = spec?.services?.[serviceName];
  if (!service) return false;
  return service.labels != null && !Array.isArray(service.labels);
}

/**
 * A pure function that joins each domain's compose service to the network
 * Traefik reaches it on, declared external at the root, and — for a
 * `docker-compose` Compose only — injects that domain's Traefik routing labels
 * into the service. The network is the shared cloudgate-network normally, and
 * the per-app `<appName>` network for an isolated deployment — the one
 * `getBuildComposeCommand` creates and connects the Traefik container to before
 * `up`. A `stack` gets no labels: see {@link stripStackRoutingLabels}.
 *
 * **Every insert below has to be a no-op on a second pass over its own output,
 * because a second pass is a route the product already has.**
 * `ComposeService.readComposeFile` returns the stored `composeFile` column only
 * for a `raw` source; for every git flavour it reads
 * `getComposeFilePath(compose)` — the path `getBuildComposeCommand` overwrote
 * with the converted file on the first deploy. So for a git-sourced stack
 * `ComposeService.getConverted` feeds an already-converted file back through
 * {@link writeDomainsToCompose}. `traefik.enable`, the routed-network label and
 * both network lists were guarded from the start; the per-domain routing labels
 * were not, and `createComposeDomainLabels` is deterministic, so the Converted
 * tab reported every router, service and middleware label twice — ten
 * duplicates for a single https domain, on the one screen the platform defaults argue an
 * operator can read what the platform will actually run. The guards are
 * load-bearing, not defensive noise.
 *
 * Rejected: de-duplicating in `ComposeService.getConverted`, which fixes the one
 * caller and leaves this function still non-idempotent for the other two
 * (`deployment-engine.service.ts`' raw injection and `getBuildComposeCommand`);
 * and having that route read a pre-conversion copy, which for a git source does
 * not exist — the clone *is* the source and the converted file has replaced it.
 *
 * **It throws three ways, and all three are the stack's own configuration
 * rather than a bug**: a domain with no service name, a domain naming a service
 * the file does not declare, and a domain on a service whose
 * labels are a map ({@link mapFormLabelsRefusal}). Every caller already reads
 * this region that way. `ComposeService.getConverted` renders the message as a
 * 400, and `deployment-engine.service.ts`' `deployCompose` runs the raw-source
 * injection *before* the clone's `rm -rf` so a refusal is provably a
 * no-op on the target and leaves `composeStatus` alone; a git source
 * refuses one line after its clone, for the same unavoidable reason H-83's
 * ownership check does — the file does not exist until the clone has run.
 */
export function addDomainsToComposeSpec(
  compose: ComposeSpecSource,
  content: string,
  domains: ComposeDomain[],
): ComposeSpecification {
  const { appName, composeType, isolatedDeployment } = compose;
  const spec = parseComposeFileOrThrow(content);

  // An isolated stack gets its own network rather than the shared one, so
  // nothing else on the server can reach it — but Traefik still has to be
  // told which of its networks to route over.
  const routedNetwork = isolatedDeployment ? appName : CLOUDGATE_NETWORK;

  for (const domain of domains) {
    const { serviceName } = domain;
    if (!serviceName) {
      throw new Error(`Domain "${domain.host}" is missing a service name`);
    }
    const service = spec.services?.[serviceName];
    if (!service) {
      throw new Error(
        `Domain "${domain.host}" is attached to service "${serviceName}" which does not exist in the compose file`,
      );
    }

    // A stack is joined to the routed network and nothing more: its
    // routers are the file-provider config the deploy writes beside it
    // (`createComposeStackTraefikConfig`), because Swarm keeps `deploy.labels`
    // on the service, where the `docker` provider never looks.
    if (composeType === 'docker-compose') {
      injectComposeDomainLabels(service, appName, domain, routedNetwork);
    }

    service.networks = addSharedNetworkToService(
      service.networks,
      routedNetwork,
    );
  }

  if (!isolatedDeployment || domains.length > 0) {
    spec.networks = addSharedNetworkToRoot(spec.networks, routedNetwork);
  }

  return spec;
}

/**
 * One Domain's Traefik routing labels on its `docker-compose` service, and the
 * `traefik.docker.network` label naming the network they are routed over —
 * the label half of {@link addDomainsToComposeSpec}, and a no-op on a second
 * pass over its own output.
 */
function injectComposeDomainLabels(
  service: ComposeServiceSpec,
  appName: string,
  domain: ComposeDomain,
  routedNetwork: string,
): void {
  const { serviceName } = domain;
  const httpLabels = composeDomainEntrypoints(domain).flatMap((entrypoint) =>
    createComposeDomainLabels(appName, domain, entrypoint),
  );

  service.labels ??= [];
  const labels: ComposeLabels = service.labels;

  // The map form is never rewritten. It is **refused** rather than skipped,
  // which is the whole of the rule — see {@link mapFormLabelsRefusal} for why a
  // refusal and not a conversion, and
  // `DomainsService.assertComposeServiceRoutable` for the seam that says it
  // earlier for the one source type that can be asked earlier. Refusing here
  // is what covers the other two: a git-sourced stack, whose file no write
  // surface ever sees, and every Domain row attached before this rule
  // existed. The throw sits above the network joins on purpose — that wiring
  // is what made the outcome look configured.
  if (!Array.isArray(labels)) {
    throw new Error(
      mapFormLabelsRefusal('docker-compose', domain.host, serviceName),
    );
  }
  if (!labels.includes('traefik.enable=true')) {
    labels.unshift('traefik.enable=true');
  }
  // The one unguarded insert in a block that guards everything else, and so
  // the whole of the dedup fix. Filtered before the splice rather than deduplicated
  // after it, so the insert position stays the only thing deciding label
  // order — the Converted tab's order is asserted, and Traefik reads
  // `traefik.enable` and the network label by name from anywhere in the
  // list. An author's own `traefik.*` label survives: a full `key=value`
  // match against what `createComposeDomainLabels` mints for this stack's
  // own domain row means the only label ever dropped is one the file
  // already carries.
  const missing = httpLabels.filter((label) => !labels.includes(label));
  labels.splice(labels.indexOf('traefik.enable=true') + 1, 0, ...missing);
  const networkLabel = `traefik.docker.network=${routedNetwork}`;
  if (!labels.includes(networkLabel)) {
    // `indexOf(…) + 1` rather than the hardcoded `1` this used to splice at
    // (cosmetic). The two agree only when Cloudgate `unshift`ed
    // `traefik.enable=true` itself; when the author wrote it further down, the
    // routed-network label landed at index 1 — ahead of the author's own
    // labels and ahead of `enable` — instead of beside the label it belongs
    // with. Harmless to Traefik, which reads both by name, and idempotent
    // either way; the reason to fix it is that it was the last
    // index arithmetic in this block that did not state what it was counting
    // from.
    labels.splice(labels.indexOf('traefik.enable=true') + 1, 0, networkLabel);
  }
}

/**
 * Takes out of a `stack`'s file the Traefik routing labels an earlier deploy
 * injected into `deploy.labels`.
 *
 * The injector used to route a stack the way it routes a `docker-compose`
 * Compose, with labels — under `deploy.labels`, which Swarm keeps on the
 * service and the `docker` provider never reads, so nothing was routed. It no
 * longer writes them, but it does not only see authors' files: a git-sourced
 * stack's converted file replaces its clone on every deploy, and
 * `ComposeService.getConverted` feeds that file back through
 * {@link writeDomainsToCompose}. Without this the labels an old deploy
 * wrote would ride along on the Converted tab indefinitely, looking like the
 * routing the stack runs with.
 *
 * **Only what Cloudgate minted for this stack goes**, recognized by shape, not
 * by the current Domain rows — a label from a Domain deleted since is still
 * one Cloudgate wrote:
 *
 * - router and service keys named `composeRouterName(appName, <key>, <entrypoint>)`;
 * - the `stripprefix-`/`addprefix-<appName>-<key>` middleware keys;
 * - `traefik.swarm.network=` naming `cloudgate-network` or `<appName>`, the two
 *   networks the injector ever routed over;
 * - `traefik.enable=true`, but only on a service that carried one of the above,
 *   since the injector added it alongside them and nowhere else.
 *
 * An author's own `traefik.*` label — for a Traefik of their own with a swarm
 * provider, say — is kept. A `deploy.labels` (and then a `deploy`) left empty by
 * the removal is removed, so a raw stack's file converts to what it was before
 * any label was written; one the author wrote empty is untouched. The map form
 * is never touched: the injector refused it rather than writing into it.
 */
function stripStackRoutingLabels(
  spec: ComposeSpecification,
  appName: string,
): void {
  const keyed = (prefix: string) => `${prefix}${appName}-`;
  const routerOrService = [
    keyed('traefik.http.routers.'),
    keyed('traefik.http.services.'),
  ];
  const middleware = [
    keyed('traefik.http.middlewares.stripprefix-'),
    keyed('traefik.http.middlewares.addprefix-'),
  ];
  const networkLabels = new Set([
    `traefik.swarm.network=${CLOUDGATE_NETWORK}`,
    `traefik.swarm.network=${appName}`,
  ]);
  const minted = (label: string): boolean => {
    if (networkLabels.has(label)) return true;
    // `<key>-<entrypoint>.` after a router/service prefix, `<key>.` after a
    // middleware one: the rest of each key is what the builders put there.
    const router = routerOrService.find((prefix) => label.startsWith(prefix));
    if (router) return /^\d+-[^.=]+\./.test(label.slice(router.length));
    const named = middleware.find((prefix) => label.startsWith(prefix));
    return named !== undefined && /^\d+\./.test(label.slice(named.length));
  };

  for (const service of Object.values(spec.services ?? {})) {
    const deploy = service.deploy;
    const labels = deploy?.labels;
    if (!deploy || !Array.isArray(labels)) continue;
    const kept = labels.filter(
      (label) => typeof label !== 'string' || !minted(label),
    );
    if (kept.length === labels.length) continue;
    const rest = kept.filter((label) => label !== 'traefik.enable=true');
    if (rest.length > 0) {
      deploy.labels = rest;
      continue;
    }
    delete deploy.labels;
    if (Object.keys(deploy).length === 0) delete service.deploy;
  }
}

/**
 * The compose file content with domains injected and the platform defaults
 * applied, ready to be written where the deploy command expects it. No disk
 * IO.
 *
 * **`echo` defaults to `'summary'`, and that default is the whole fix
 * for a raw stack.** The falsifiable claim was that such a
 * stack *"refuses at `assertComposeContentClaimable`"*, and it does not: an earlier
 * change moved the raw injection **in front of** the clone's `rm -rf`, so
 * `deployCompose` calls this function with `compose.composeFile` before the
 * guard ever runs, and the two refusal classes the guard converts arrive here
 * first. They arrive **raw** — a `YAMLParseError` straight out of
 * `parseComposeFileOrThrow` with no {@link composeFileParseRefusal} in the
 * path, so neither the first-line trim nor the 500-unit cap applies, and a
 * `ComposeLabelRefusal` with its `message` rather than its `summary`. Measured:
 * a raw stack whose file will not parse put `yaml`'s sentence **and its caret
 * diagram** — the whole offending source line — into
 * `notifier.buildError`'s `errorMessage`, which is the one echo the content guard says
 * explicitly must never happen. So the leak was strictly worse than the version
 * that was filed, and closing it at the guard alone would have left the raw
 * source type, the ticket's own example, untouched.
 *
 * The two callers split the way the audience does. `ComposeService.getConverted`
 * passes `'verbatim'`: it is answering `GET /compose/:id/converted` to a caller
 * `checkServiceAccess(…, 'read')` has already admitted, which is the audience
 * the column has. The deployment engine passes nothing, and gets the summary,
 * because its `catch` hands one string to a Deployment log *and* to a
 * customer-supplied webhook.
 *
 * What is **not** summarized: the three refusals {@link addDomainsToComposeSpec}
 * raises itself, which name `domain.host` and `domain.serviceName`. Those are
 * `domain` columns rather than the encrypted body, they are the whole content of
 * the refusal, and an operator reading *"Domain x is attached to service y which
 * does not exist"* out of a notification has the fix in the sentence. See
 * {@link composeContentRefusalSummary}, which answers `null` for them.
 */
export function writeDomainsToCompose(
  compose: ComposeSpecSource,
  content: string,
  domains: ComposeDomain[],
  echo: ComposeRefusalEcho = 'summary',
): string {
  try {
    return writeDomainsToComposeVerbatim(compose, content, domains);
  } catch (error) {
    if (echo === 'verbatim') throw error;
    const summary = composeContentRefusalSummary(error);
    // A plain `Error`, not an `HttpException`: this file is pure and the two
    // seams that turn a refusal into a status live in `compose.service.ts` and
    // in the engine's `catch`. Rethrowing the original when there is no summary
    // is what keeps `addDomainsToComposeSpec`'s own refusals — and any bug in
    // this module — exactly as they were.
    throw summary === null ? error : new Error(summary);
  }
}

function writeDomainsToComposeVerbatim(
  compose: ComposeSpecSource,
  content: string,
  domains: ComposeDomain[],
): string {
  // The early return that used to hand an isolated, domain-less
  // stack's bytes back verbatim also skipped every platform default, so the one
  // stack shape nobody routes was the one shape that came back uncapped and
  // unrestarted. It parses and re-serializes now; the cost is the author's
  // comments and key order in that one case, which the Converted tab already
  // shows for every other case.
  const spec =
    domains.length === 0 && compose.isolatedDeployment
      ? parseComposeFileOrThrow(content)
      : addDomainsToComposeSpec(compose, content, domains);
  // On both arms, for the reason the guard below gives: an isolated stack whose
  // last Domain was removed is the domain-less arm, and its converted file can
  // still carry the labels an earlier deploy wrote.
  if (compose.composeType === 'stack') {
    stripStackRoutingLabels(spec, compose.appName);
  }
  // H-83's static half, at the one function every branch passes through: the
  // raw injection in `deployment-engine.service.ts`, `getBuildComposeCommand`
  // for every git flavour, and `GET /compose/:id/converted`. It runs on **both**
  // arms above, which is why it is here rather than inside
  // `addDomainsToComposeSpec` — the isolated, domain-less stack takes the other
  // arm, and that is the one shape already caught skipping a rule.
  //
  // After the injection, not before, and it costs nothing to be: the ownership
  // half admits Cloudgate's own generated labels by construction (they name this
  // stack's own domain rows), so the guard needs no way to tell an author's
  // label from a generated one — see `compose-labels.ts`. Checking the injected
  // spec is the stronger statement of the two, because it is the spec that
  // reaches Docker.
  //
  // The return value is discarded here on purpose. Ownership needs a database
  // and an organization, and this file is pure; the callers that have both run
  // `readComposeHostClaims` themselves. What this call buys is that no branch
  // can emit a rule nobody can own, whatever its caller forgot.
  readComposeHostClaimsFromSpec(spec);
  return stringify(applyComposeDefaults(compose, spec), { lineWidth: 1000 });
}

/** Joins a service to the routed network, keeping its default one. */
function addSharedNetworkToService(
  networks: ComposeServiceNetworks | undefined,
  networkName: string,
): ComposeServiceNetworks {
  const result = networks ?? [];
  if (Array.isArray(result)) {
    if (!result.includes(networkName)) result.push(networkName);
    if (!result.includes('default')) result.push('default');
  } else {
    result[networkName] ??= {};
    result.default ??= {};
  }
  return result;
}

/** Declares the routed network as external at the compose root. */
function addSharedNetworkToRoot(
  networks: ComposeSpecification['networks'],
  networkName: string,
): NonNullable<ComposeSpecification['networks']> {
  return { ...networks, [networkName]: { external: true } };
}

// The deploy shell script. Everything below is pure — the deploy slice feeds it
// to RemoteExecService.

/**
 * The compose file's absolute path on the stack's own Server.
 *
 * **Rooted on that machine and not on this process**: the join was
 * `composeDirectory()`, i.e. `localCloudgateDirectory()`, for every machine
 * alike, while all **six** of this function's callers bake the result into a
 * command sent to `compose.serverId`. Three of them write through it —
 * {@link composeStartCommand} rewrites the file, {@link getBuildComposeCommand}
 * writes it, and {@link getCreateComposeEnvFileCommand} `dirname`s it to put
 * the `.env` beside it — and three `cat` it:
 * `DeploymentEngineService.readComposeContent`, `ComposeService.readComposeFile`
 * and `ComposeService.readClaimableOnDiskCompose`. This said "all four … three
 * of them writing" until a census counted the call sites rather than the sentence.
 * See `composeDirectoryOn` for the set this moved with and why it had to move
 * as one.
 */
export function getComposeFilePath(
  compose: Pick<
    DeployableComposeSource,
    | 'appName'
    | 'sourceType'
    | 'composePath'
    | 'serverId'
    | 'composeId'
    | 'cloudAccountId'
  >,
): string {
  const path =
    compose.sourceType === 'raw' ? 'docker-compose.yml' : compose.composePath;
  return join(
    composeDirectoryOn(stackRootId(compose)),
    compose.appName,
    'code',
    path,
  );
}

/**
 * The docker CLI arguments (without the leading `docker`). A user-supplied
 * command wins verbatim.
 *
 * `appName` and `composePath` are quoted, on the rule in
 * `builders/build-strategy.ts`: `composePath` is a caller-set column
 * that lands in `-f`/`-c`, and the whole string is interpolated into
 * `docker …` on the build server.
 *
 * `compose.command` is the exception and stays verbatim: it is a *command* by
 * contract — the operator's own replacement for these arguments — not a value
 * word, exactly as `containerSearch` is in the schedule builders. Quoting it
 * would make it one long argument to `docker` and break every use of it.
 */
export function createComposeCommand(
  compose: Pick<
    DeployableComposeSource,
    'appName' | 'composeType' | 'sourceType' | 'composePath' | 'command'
  >,
): string {
  if (compose.command) {
    return compose.command.trim().split(/\s+/).join(' ');
  }

  const path =
    compose.sourceType === 'raw' ? 'docker-compose.yml' : compose.composePath;
  if (compose.composeType === 'stack') {
    return `stack deploy -c ${quote([path])} ${quote([compose.appName])} --prune --with-registry-auth`;
  }
  return `compose -p ${quote([compose.appName])} -f ${quote([path])} up -d --build --remove-orphans`;
}

/**
 * The shell behind Remove containers, the lifecycle rung between Stop and
 * Delete (ADR-0011): a `docker-compose` project's containers go, and its
 * network, project directory, volumes and Cloudgate row all stay, so `start`
 * brings it back afterwards.
 *
 * It exists because a volume cannot be restored while any container references
 * it — Docker's refcount counts exited containers and `docker volume rm`
 * refuses regardless of `--force` — and Stop runs `docker compose stop`, which
 * leaves exactly such containers behind. `--stop` is what lets the same command
 * serve a running stack and an already-stopped one, so an operator never has to
 * press Stop first.
 *
 * Three shapes were rejected, and a later reader should not reintroduce any of
 * them:
 *
 *   * `-v` would remove the anonymous volumes along with the containers, which
 *     is the opposite of the point — the volume has to survive to be restored
 *     into. That reads as if the absence handed back usable data in every case;
 *     it does so only for a *named* volume. An anonymous one survives
 *     with its contents and is then never re-attached, because `up -d` carries
 *     an anonymous mount across a recreate by copying it off the previous
 *     container and `rm` destroyed that container. So every Remove containers →
 *     Start cycle leaves one dangling volume per anonymous mount, swept from
 *     Settings → Maintenance → "Remove unused volumes". `-v` stays absent
 *     anyway: destroying the data outright is worse than orphaning it, and
 *     re-attachment was rejected because the only way to reach the preserved
 *     volume is to write its 64-hex id into the operator's own compose file,
 *     turning their unnamed mount into a named one behind their back.
 *   * `docker compose down` would also remove the project network, which
 *     Traefik is attached to; something would then have to reconnect it on the
 *     next `start` or the stack returns unrouted. Networks hold no volumes, so
 *     removing one buys nothing here.
 *   * a Delete ends by `rm -rf`ing the project directory
 *     (`compose/compose-directory.ts`), which `start` reads to bring the
 *     project back up.
 *
 * Unlike its `start`/`stop` siblings, whose commands are inline in
 * ComposeService, this one is a named export: the three rejections above are all
 * absences, and an absence is only pinned by a test that can name the command
 * on its own.
 *
 * `serverId` leads the parameters and is the stack's own, because two of this
 * builder's words are rooted on that machine and neither is this process's: the
 * project directory it `cd`s into, and — through `withVolumeLock` — the lock
 * file the preamble opens. A wrong root on the second was not a
 * misplaced directory but a refusal: `exec 9>` does not create its parent, and
 * the `mkdir` fallback reads the same missing directory as *busy*.
 *
 * `volumeNames` are the volumes this removal has to hold while it runs:
 * removing a container releases a volume a backup may be tarring right now, so
 * Remove containers is a third participant in the volume lock alongside the
 * backup and the restore. They arrive as a parameter rather than being resolved
 * here because they come from the caller's volume-backup rows, and everything in
 * this file is pure — a database read would make this builder the only one that
 * is not. `fail-fast`, not `wait`: this runs inside an HTTP request, so the
 * alternative is holding the response open for however long a tar of somebody
 * else's volume takes, and the caller answers the refusal with a 409.
 */
export function removeComposeContainersCommand(
  serverId: string | null,
  appName: string,
  volumeNames: string[],
): string {
  return withVolumeLock(
    { serverId, volumeNames, mode: 'fail-fast' },
    `cd ${quote([composeProjectDirectory(serverId, appName)])} && env -i PATH="$PATH" docker compose -p ${quote([appName])} rm --stop --force`,
  );
}

/**
 * Writes `content` to `path` on the build server, base64-encoded so no byte of
 * a compose file has to survive a shell.
 *
 * One writer rather than the two it used to be: `getBuildComposeCommand` writes
 * the converted file on a deploy and {@link composeStartCommand} rewrites it on
 * a Start, and a second copy of the encode/redirect pair is how the two would
 * come to disagree about the encoding of a file only one of them can read back.
 * No trailing `;` — the caller decides whether the next command is sequenced or
 * conditional on this one.
 */
export function writeComposeFileCommand(path: string, content: string): string {
  return `echo "${encodeBase64(content)}" | base64 -d > ${quote([path])}`;
}

/**
 * The shell behind `POST /compose/:id/start`: re-apply the platform defaults to
 * the converted compose file already on disk, then bring the project up from it
 * (H-98).
 *
 * **Why anything is written here at all.** `start` runs `docker compose up -d`
 * over the converted file `getBuildComposeCommand` left in the code directory,
 * and `up -d` *creates containers* — so it is a create site for
 * `common/config/container-logs.ts`'s kind 3, and it was the one create site in
 * `backend/src` that read neither the log cap nor the restart policy. A stack
 * whose stored converted file was written before those defaults carries `restart:`
 * zero times and `logging:` zero times, so it came back from a Start with
 * `RestartPolicy=no` and an uncapped log driver, dropped again at the next
 * daemon restart, and the full-disk failure mode — a full disk on the platform host,
 * which takes down every workload on it, not only the noisy one — stayed
 * reachable on every upgraded install until each stack was redeployed once.
 * Measured on the host, one row, one appName, minutes apart: after Start the
 * containers read `restart=no` with an empty log `Config`, and after Deploy the
 * same two read `restart=unless-stopped` with the platform cap. (The ceiling's
 * own values are `common/config/container-logs.ts`'s and are deliberately not
 * restated anywhere in this file — `container-logs.spec.ts` asserts that.)
 *
 * **What it is deliberately not.** Routing `start` through the deploy path is
 * the other way to close this, and `ComposeService.start`'s docblock rejects it
 * in writing: `start` preserves container identity and the writable layer and
 * does not clone, patch, re-inject or rebuild (ADR-0011), and a guard must
 * not buy its coverage by redefining the verb it guards. So this re-applies two
 * keys to a file Cloudgate itself wrote and generated nothing else: no clone, no
 * `--build`, no `--remove-orphans`, no domain re-injection, no `.env` rewrite,
 * no volume-lock or log-path machinery. `getBuildComposeCommand` remains the
 * only builder that regenerates the file from the row.
 *
 * **The write is conditional on the defaults actually changing the file**, which
 * is what keeps a Start of a newer stack byte-for-byte the command it was
 * before this existed — the common case touches nothing. `&&` and not `;`: a
 * write that failed must not be followed by an `up -d` over a half-written
 * compose file (H-96 is the same lesson one module over).
 *
 * The one cost, and it is `writeDomainsToCompose`'s already: a file that *does*
 * need the keys is re-serialized, so an older isolated domain-less stack — the
 * one shape whose bytes the old early return handed back verbatim — loses its
 * author's comments and key order on its first Start. It is Cloudgate's own
 * converted copy, not the operator's file, and every other stack shape has
 * shown it re-serialized on the Converted tab.
 *
 * A file that parses to nothing — absent, empty, comments only — is left alone
 * and handed to `up -d` as it stands, for the reason
 * `assertOnDiskComposeClaimable` gives about the same bytes: `start` on a stack
 * that was never deployed has nothing on disk, `up -d` fails, and the caller's
 * directory probe is what then names the cause — inventing a file here
 * would name the wrong problem.
 *
 * It cannot change what the stack claims. `applyComposeDefaults` writes only
 * `restart:` and `logging:`, and `readComposeHostClaims` reads neither, so the
 * ownership check the caller ran over the bytes it read off disk still holds for
 * the bytes written back — see `ComposeService.start`.
 */
export function composeStartCommand(
  compose: Pick<
    DeployableComposeSource,
    | 'appName'
    | 'composeType'
    | 'sourceType'
    | 'composePath'
    | 'serverId'
    | 'composeId'
    | 'cloudAccountId'
  >,
  onDisk: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path =
    compose.sourceType === 'raw' ? 'docker-compose.yml' : compose.composePath;
  // `composePath` is a caller-set column and `appName` a minted one: both are
  // quoted, on the rule in `builders/build-strategy.ts`.
  const up = `cd ${quote([composeCodeDirectory(stackRootId(compose), compose.appName)])} && env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} -f ${quote([path])} up -d`;

  const spec = parseComposeFile(onDisk);
  if (!spec) return up;
  const defaulted = stringify(applyComposeDefaults(compose, spec, env), {
    lineWidth: 1000,
  });
  if (defaulted === onDisk) return up;

  return `${writeComposeFileCommand(getComposeFilePath(compose), defaulted)} && ${up}`;
}

/**
 * `docker compose stop`, `restart` or `start` on a stack's existing
 * containers, by its project name from its project directory: Stop's and
 * Restart's command, and Start's on a Stack VM (ADR-0070, #1370), where the
 * containers its Stop stopped are started again as they were.
 *
 * Start on a Server stays {@link composeStartCommand}'s `up -d`, which
 * re-applies the platform defaults to stacks deployed before them (H-98);
 * every stack on a Stack VM was deployed with them, so its Start needs no
 * rewrite and keeps container identity, as the spec asks. One builder, after
 * Stop and Restart had each spelled the same line inline (#1357 review).
 */
export function composeLifecycleCommand(
  compose: Pick<
    DeployableComposeSource,
    'appName' | 'serverId' | 'composeId' | 'cloudAccountId'
  >,
  verb: 'stop' | 'restart' | 'start',
): string {
  return `cd ${quote([composeProjectDirectory(stackRootId(compose), compose.appName)])} && env -i PATH="$PATH" docker compose -p ${quote([compose.appName])} ${verb}`;
}

/**
 * One of the two questions a compose stack's workload can be asked — the read
 * that decides whether a refused teardown may drop the row. It lives
 * here rather than beside the Application's and the databases' copies because a
 * `stack` is a swarm stack and a `docker-compose` project is a set of
 * containers, and neither command answers for the other.
 *
 * **Nothing chooses between them on a row's behalf any more.**
 * `readComposeWorkloadPresence` below asks both, for the reason stated there:
 * choosing by the stored `composeType` made the whole orphan safety property
 * depend on a column the update route lets a caller change (H-87).
 *
 * Distinguished **in the shell**, not in TypeScript, because
 * `RemoteExecService` rejects on any non-zero exit and a plain try/catch cannot
 * separate "not there" from "cannot reach the daemon". All three answers come
 * back on stdout at exit 0, in {@link presenceProbeCommand}'s shape — which is
 * where the reason lives. Both branches used to be
 * `<question> && echo present || echo absent`, and `||` swallows `Cannot connect
 * to the Docker daemon` like any other non-zero exit, so a stopped or wedged
 * daemon answered `absent` for a *running* project (H-95). Do not collapse the
 * three branches into two.
 *
 * **Each branch's reachability check runs in its own branch's environment**, and
 * that is not cosmetic. The `docker-compose` half runs under `env -i`, so host
 * variables never reach compose — which means it never sees `DOCKER_HOST`
 * either. Measured on the host with `DOCKER_HOST=tcp://127.0.0.1:1` exported:
 * `docker compose -p w02-shared-compose ps -q` failed, and
 * `env -i PATH="$PATH" docker compose -p w02-shared-compose ps -q` returned the
 * live container id. A bare `docker version` guarding that question would answer
 * for a daemon the question is not asking, which is a false `unknown` — safe,
 * but it would refuse deletes for a reason the operator cannot see.
 *
 * **The two questions each carry their own check rather than sharing one.**
 * Sharing would need either a third exec (more round trips, not fewer) or the
 * two questions folded into one program, and folding them would undo the flat
 * "it asks both, unconditionally" invariant `readComposeWorkloadPresence` was
 * deliberately built to let a test pin (H-87). The cost is one extra `docker
 * version` per question — 43 ms on the host, next to the 32 ms of the read it
 * guards — paid only on a delete.
 */
export function composePresenceCommand(
  appName: string,
  composeType: 'docker-compose' | 'stack',
): string {
  if (composeType === 'stack') {
    return presenceProbeCommand({
      workloadPresent: `docker stack ps ${quote([appName])} --quiet >/dev/null 2>&1`,
    });
  }
  return presenceProbeCommand({
    daemonReachable: `env -i PATH="$PATH" docker version >/dev/null 2>&1`,
    workloadPresent: `[ -n "$(env -i PATH="$PATH" docker compose -p ${quote([appName])} ps --quiet 2>/dev/null)" ]`,
  });
}

/**
 * Every compose type a presence read has to ask about. Pinned as a literal
 * rather than read off `composeTypeEnum` so that adding a third type to the
 * column fails a test in `compose-commands.spec.ts` instead of silently
 * shipping a probe that never asks about it — the same argument the exhaustive
 * `switch` over `ServiceType` in `common/service-cascade.ts` makes.
 */
export const COMPOSE_PRESENCE_TYPES = ['docker-compose', 'stack'] as const;

/**
 * Whether a compose stack's workload is still there — the read Delete runs
 * between the teardown and the row, and the one place the compose answer
 * is decided (H-87).
 *
 * **It does not consult the row's `composeType`.** It used to, and that made
 * the whole orphan safety property depend on a column `updateComposeSchema`
 * deliberately lets a caller change. A `PATCH {"composeType":"stack"}` on a
 * deployed `docker-compose` row made `docker stack ps` the probe; `docker stack
 * ps` answers nothing about a compose project; {@link readWorkloadPresence}
 * reads that as `'absent'`; and the delete then dropped the row while the
 * containers kept running, behind a bare 200 that positively claims the
 * teardown was confirmed. Measured on the host, one running project, same name,
 * same second:
 *
 * ```
 * docker compose -p w02-shared-compose ps -q  → 444d9d36df9e…                        (present)
 * docker stack ps  w02-shared-compose -q      → nothing found in stack: …            (absent)
 * ```
 *
 * So it asks **both** and takes the pessimistic answer: `'present'` if either
 * says so, `'absent'` only if **both** do, and `'unknown'` otherwise — never
 * the other way round. A probe whose failure mode is `'absent'` is not a probe.
 * That also covers the row whose type was wrong from the start — an import, a
 * restore, a migration — which refusing the `PATCH` would not have, and it is
 * why the fix is here rather than in the DTO. The cost is one extra exec on a
 * delete, and it is only paid on a delete.
 *
 * The verdict rule itself is still {@link readWorkloadPresence}'s, per
 * `common/workload-presence.ts`: this adds the compose-specific "ask both",
 * nothing else. It takes a `run` thunk rather than a `RemoteExecService` for the
 * reason everything else in this file is a pure builder — the exec layer is the
 * caller's, and both call sites (`ComposeService.remove` and the delete cascade)
 * reach it differently.
 *
 * One question at a time rather than `Promise.all`, and it asks the second even
 * when the first said `'present'`. Sequential is `tearDownCascadeChildren`'s
 * reason one level down — on a remote row each question is its own SSH
 * connection, and that cascade is already sequential per child so it does not
 * open them in parallel. Unconditional so that "it asks both" is a flat
 * invariant a test can pin, rather than one that holds only for the rows that
 * happen to be gone.
 */
export async function readComposeWorkloadPresence(
  appName: string,
  run: (command: string) => Promise<string>,
): Promise<WorkloadPresence> {
  const answers: WorkloadPresence[] = [];
  for (const composeType of COMPOSE_PRESENCE_TYPES) {
    answers.push(
      await readWorkloadPresence(() =>
        run(composePresenceCommand(appName, composeType)),
      ),
    );
  }
  if (answers.includes('present')) return 'present';
  if (answers.every((answer) => answer === 'absent')) return 'absent';
  return 'unknown';
}

/**
 * The stack's project directory on its Server — what Stop and Remove
 * containers `cd` into, and what a Deployment creates. One spelling, so the
 * probe below asks about exactly the directory the command it follows used.
 */
export function composeProjectDirectory(
  serverId: string | null,
  appName: string,
): string {
  return join(composeDirectoryOn(serverId), appName);
}

/** The `code` directory inside it, which Start's `up -d` runs from. */
export function composeCodeDirectory(
  serverId: string | null,
  appName: string,
): string {
  return join(composeProjectDirectory(serverId, appName), 'code');
}

/**
 * Whether a stack's directory is on its Server — asked by Start, Stop and
 * Remove containers once their command has failed, to tell a stack that was
 * never deployed from any other failure.
 *
 * All three `cd` into a directory only a Deployment creates, so on a stack
 * that was never deployed the shell's `can't cd` was the whole answer, and it
 * arrived as an unexplained 500. Asked **after** the failure rather than
 * before the command, so the path that works is the one exec it always was.
 *
 * The same zero-exit-either-way shape as {@link composePresenceCommand}, for
 * its reason — `RemoteExecService` rejects on any non-zero exit, so "not
 * there" has to be said on stdout — and read by {@link readWorkloadPresence},
 * so a Server that cannot be reached is `'unknown'` and never `'absent'`.
 * There is no daemon question to guard: this is a directory, not a workload.
 */
export function composeDirectoryProbeCommand(directory: string): string {
  return `if [ -d ${quote([directory])} ]; then echo present; else echo absent; fi`;
}

/** {@link composeDirectoryProbeCommand}, read into the three-valued answer. */
export function readComposeDirectoryPresence(
  directory: string,
  run: (command: string) => Promise<string>,
): Promise<WorkloadPresence> {
  return readWorkloadPresence(() =>
    run(composeDirectoryProbeCommand(directory)),
  );
}

/**
 * The clock, as a seam — `deployment-engine/await-convergence.ts`'s
 * `ConvergenceClock` argument, one module over: a test that has to exhaust the
 * whole settle window must be able to do it in microseconds, and fake timers
 * around a loop that awaits an exec between every sleep is the arrangement that
 * produces suites which hang instead of failing.
 *
 * The same shape rather than an import of it, on purpose: a compose delete is
 * not a convergence, and coupling this file's delete path to the deployment
 * engine's poll would make the two budgets one decision. Structural typing means
 * a caller with a clock already in hand can still pass it to both.
 */
export interface SettleClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

/** The injection token `ComposeModule` binds to {@link systemSettleClock}. */
export const COMPOSE_SETTLE_CLOCK = 'COMPOSE_SETTLE_CLOCK';

export const systemSettleClock: SettleClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** How often the settle poll re-asks. */
export const COMPOSE_SETTLE_POLL_MS = 1_000;

/**
 * The ceiling on the whole wait.
 *
 * Measured, not chosen: on the host a `docker stack rm` of a one-task stack left
 * `docker stack ps --quiet` naming a task in `Shutdown` for **6–7 s** (3 trials
 * of 3), so the budget is a little over twice the observed drain. It is spent
 * only on a delete, and only on one whose teardown the daemon accepted.
 */
export const COMPOSE_SETTLE_BUDGET_MS = 15_000;

/**
 * {@link readComposeWorkloadPresence}, re-asked until the workload is gone or a
 * bounded window runs out (H-99).
 *
 * **What it fixes.** `ComposeService.remove` tears the stack down and then asks
 * whether it is gone, in that order and for the orphan rule's reason. For a `stack` row the
 * teardown is `docker stack rm`, which returns as soon as the daemon *accepts*
 * the removal, while `docker stack ps <name> --quiet` keeps naming tasks in
 * `Shutdown` for several seconds afterwards — so the probe answered `present`
 * about the removal the same request had just issued, and the caller got a 409.
 * Reproduced 3/3 on the host: `409` at t+0, `409` at t+3, `200` at t+6/t+7. A
 * `stack`-type compose could not be deleted on the first attempt, ever.
 *
 * **It does not make the probe lie, and a spent budget still refuses.** The
 * answer returned is always the last one a probe actually gave; nothing here
 * synthesizes `absent`. The property is that Cloudgate does not drop a row
 * while a workload it cannot see might still be running, and waiting for the
 * daemon to agree is the opposite of inventing an answer — it is
 * `awaitConvergence`'s "wait, do not guess", with a smaller budget.
 *
 * **Only `'present'` is re-asked.** `'unknown'` means the daemon or the
 * transport could not answer at all, and the refusal it produces already tells
 * the operator the actionable thing — *delete again when the server is
 * reachable*. Re-asking it would multiply an SSH connect timeout by the poll
 * count and turn a delete against a Server that is gone into a minutes-long
 * request, buying nothing: nothing about a dead transport settles in fifteen
 * seconds. So the new wait is confined to the answer the race actually produces.
 *
 * The first read is immediate, so the happy path — teardown succeeded, project
 * gone — costs exactly what it did before this existed.
 */
export async function awaitComposeWorkloadAbsent(
  appName: string,
  run: (command: string) => Promise<string>,
  clock: SettleClock = systemSettleClock,
  budgetMs: number = COMPOSE_SETTLE_BUDGET_MS,
): Promise<WorkloadPresence> {
  const startedAt = clock.now();
  for (;;) {
    const presence = await readComposeWorkloadPresence(appName, run);
    if (presence !== 'present') return presence;
    const elapsedMs = clock.now() - startedAt;
    if (elapsedMs >= budgetMs) return presence;
    await clock.sleep(Math.min(COMPOSE_SETTLE_POLL_MS, budgetMs - elapsedMs));
  }
}

/**
 * The teardown half of `readComposeWorkloadPresence` above: disconnect Traefik
 * from the app network and take **both** the swarm stack and the compose
 * project of that name down.
 *
 * **It no longer drops the project directory**. That `rm -rf` was this
 * program's last statement and so ran ahead of the presence refusal, and the
 * tree holds the stack's file mounts (`files/`) and its Trace store's data
 * (`traces/`) as well as its clone — so a Delete answering *"the Compose was
 * kept"* had already erased both. `compose/compose-directory.ts` is that
 * removal now, and both Deletes run it after their refusal. Nothing here needs
 * the directory: `docker compose -p … down` names the project, not a file.
 *
 * It moved out of `ComposeService.teardownCommand` — which now delegates here —
 * because a Project or Environment delete has to tear its compose children down
 * exactly the way the per-Compose delete does, and a second copy of this
 * string is the kind of drift that leaves a stack running while the row goes.
 * The failure would not even be loud: the cascade's presence read would answer
 * `'present'` and refuse the delete, so the operator would see a 409 they could
 * not act on rather than an error naming the command that did not run.
 *
 * **Both, not the row's type, and that is the other half of H-87.** This used to
 * branch on `composeType` exactly as the probe did, so a `PATCH
 * {"composeType":"stack"}` on a deployed `docker-compose` row aimed the teardown
 * at the wrong daemon subsystem too. Both call sites run it inside a
 * `try { } catch { }` whose comment says "what is left is decided by the presence
 * read below" — so the wrong teardown failed, was swallowed, and then the read
 * that exists to catch that asked the same wrong question. Fixing only the
 * probe would leave a delete that never attempts the right teardown and 409s
 * forever: better than an orphan, not correct.
 *
 * Running the other subsystem's teardown is a **verified** no-op, not an assumed
 * one. On the host, docker 29.3.1, against a live `docker-compose` project
 * `h87a` and a live swarm stack `h87b`:
 *
 * ```
 * docker stack rm h87a              → "Nothing found in stack: h87a", exit 0;   h87a-web-1 still Up
 * docker compose -p h87b down       → "No resource found to remove", exit 0;    h87b_web still 1/1
 * ```
 *
 * Neither can reach the other's objects by construction: `docker stack rm`
 * matches `com.docker.stack.namespace`, `docker compose down` matches
 * `com.docker.compose.project`, and a `stack deploy` sets only the first while
 * `compose up` sets only the second. `appName` is unique across the compose
 * table, so there is no second row of that name to catch either.
 *
 * A stack's Traefik routing file (`composeStackRoutingCommand`) goes with
 * it, for either kind, on the same reasoning: `rm -f` of a file only a Compose
 * of this name can have written is a no-op where there is none, and a router
 * left behind would keep advertising the stack's hosts at a service that is
 * gone — the reason an Application's delete removes its own file.
 *
 * `deleteVolumes` keeps its exact meaning from the Compose route: volumes
 * survive a Delete unless asked for, per `CONTEXT.md`'s **Delete**, and the
 * cascade never asks. It stays on the compose half because `docker stack rm` has
 * no volume flag — a stack's volumes are the nodes'.
 *
 * `serverId` leads the parameters because the routing file's path is rooted on
 * the stack's own Server. It is taken from the row rather than derived.
 */
export function composeTeardownCommand(
  serverId: string | null,
  appName: string,
  deleteVolumes: boolean,
): string {
  const quotedAppName = quote([appName]);
  return `
docker network disconnect ${quotedAppName} cloudgate-traefik;
docker stack rm ${quotedAppName};
env -i PATH="$PATH" docker compose -p ${quotedAppName} down ${deleteVolumes ? '--volumes ' : ''};
docker network rm ${quotedAppName} >/dev/null 2>&1 || true;
rm -f ${quote([dynamicTraefikConfigPath(composeStackConfigName(appName), serverId)])}`;
}

/**
 * Writes the interpolated .env beside the compose file.
 * APP_NAME/COMPOSE_PROJECT_NAME pin the compose project name; DOCKER_CONFIG
 * keeps registry auth resolvable under `env -i`.
 *
 * The trailing `'\n'` on the join is load-bearing and not cosmetic: a
 * join of *n* lines emits *n-1* separators, so the file used to end mid-line,
 * `wc -l` answered 2 for three keys, and any consumer that discards an
 * unterminated final line would have dropped `DOCKER_CONFIG` outright. Only
 * `docker compose`'s own dotenv being forgiving kept registry auth working.
 * The terminator belongs here rather than in `prepareEnvironmentVariables`,
 * which was the rejected placement: that returns an array of lines and it is
 * the file writer, not the formatter, that decides a file's bytes. Nothing
 * reads this `.env` back, and the write truncates, so no consumer can see the
 * difference — line-counting tools can.
 *
 * The `DOCKER_CONFIG` guard asks dotenv rather than the file body,
 * because `includes('DOCKER_CONFIG')` was a strictly looser notion of "already
 * set" than the one that decides the file's keys: those come from `parse` in
 * `prepareEnvironmentVariables`, whose key charset is `[\w.-]+`. So a stack env
 * carrying `# DOCKER_CONFIG is set on the host`, `MY_DOCKER_CONFIG_PATH=/opt/dc`
 * or `NOTE=see DOCKER_CONFIG docs` silently dropped the default, and the deploy's
 * `env -i` then left the daemon no `config.json` to resolve — a stack pulling
 * from a private registry failed to pull, naming an image rather than the comment
 * three lines up. Rejected: an anchored `/^DOCKER_CONFIG=/m`, which is a second
 * hand-rolled reading of dotenv's grammar and so the same disagreement again.
 * The check deliberately stays *after* `compose.env` is appended, so a caller's
 * own `DOCKER_CONFIG` still wins and is not duplicated.
 */
export function composeEnvFileContent(
  compose: DeployableComposeSource,
): string {
  let envContent = `APP_NAME=${compose.appName}\n`;
  envContent += `COMPOSE_PROJECT_NAME=${compose.appName}\n`;
  envContent += compose.env || '';
  if (!('DOCKER_CONFIG' in parseEnv(envContent))) {
    envContent += '\nDOCKER_CONFIG=/root/.docker';
  }

  return `${prepareEnvironmentVariables(
    envContent,
    compose.environment.project.env,
    compose.environment.env,
  )
    .map(composeDotenvLine)
    .join('\n')}\n`;
}

/**
 * Writes {@link composeEnvFileContent} beside the compose file, from
 * {@link COMPOSE_ENV_VARIABLE} in the program's environment: the file
 * is every generated secret, and the program's text is what `ps` reads.
 *
 * The file keeps the umask's mode, where the converted file is made `0600`:
 * the stack directory `deployCompose`'s clone step closes is what protects it,
 * and a `build: .` may `COPY` it into an image whose user has to read it
 * (`platform-file-modes.spec.ts`).
 */
export function getCreateComposeEnvFileCommand(
  compose: DeployableComposeSource,
): string {
  const quotedPath = quote([
    join(dirname(getComposeFilePath(compose)), '.env'),
  ]);
  return `
touch ${quotedPath};
printf '%s' "$${COMPOSE_ENV_VARIABLE}" > ${quotedPath};
`;
}

/** What `export` — and so `docker stack deploy`'s interpolation — can name. */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Stack deploys read env at the shell (swarm has no .env support): the
 * interpolated variables as a script of quoted `export`s, which the stack
 * deploy's shell `eval`s off its stdin ({@link getBuildComposeCommand}), and
 * the keys it had to leave out.
 *
 * They were `KEY=value` words on the `env -i … docker stack deploy` prefix,
 * which put every value in the program's text and then in `env`'s argv.
 * `env` took any name; `export` takes only a shell name, and a key
 * such as `service.port` — which dotenv's `[\w.-]+` admits — is one no
 * `${…}` in the file can reference, so it is left out and the log says so.
 */
function composeStackEnv(compose: DeployableComposeSource): {
  script: string;
  skipped: string[];
} {
  const entries = Object.entries(
    getEnvironmentVariablesObject(
      compose.env,
      compose.environment.project.env,
      compose.environment.env,
    ),
  );
  return {
    script: entries
      .filter(([key]) => SHELL_NAME.test(key))
      .map(([key, value]) => `export ${key}=${quote([value])}`)
      .join('\n'),
    skipped: entries.map(([key]) => key).filter((key) => !SHELL_NAME.test(key)),
  };
}

/**
 * What a deploy with isolation **off** does about the network an earlier
 * isolated deploy left: detach Traefik from `<appName>` and remove it,
 * once nothing but Traefik is on it.
 *
 * The isolated branch of {@link getBuildComposeCommand} creates the network and
 * connects Traefik; before this the off branch emitted nothing, so a stack
 * switched back off kept its network and Traefik stayed attached to it until
 * the stack was deleted. It runs *after* the deploy, because the deploy is
 * what moves the stack's routed services back onto `cloudgate-network` —
 * before it, they are still on `<appName>`.
 *
 * **"Nothing else uses it" is asked, not assumed, and only where the answer
 * is complete.** The Go template lists every container on the network except
 * Traefik; any answer at all leaves both the network and Traefik's attachment
 * alone, because detaching Traefik from a network something is still routed
 * over would take its domains down. But `.Containers` lists only *this
 * node's* endpoints, so it is a whole answer for a `local`-scope bridge and
 * not for a `swarm`-scope overlay, whose old tasks may be on other nodes — an
 * empty list there would detach Traefik and then have `docker network rm`
 * refuse. So the release asks the scope first and leaves anything but `local`
 * to the delete, which removes it after `awaitComposeWorkloadAbsent` has seen
 * the tasks gone cluster-wide (`compose-network.ts`). It keys off the
 * network's scope rather than `composeType`, which a `PATCH` can change after
 * the overlay was made (H-87).
 *
 * **Every statement is tolerated**, because the script runs under `set -e` and
 * none of this may fail a deploy: a stack that was never isolated has no such
 * network (the `inspect` answers no and nothing runs), and `docker network rm`
 * still refuses a network with an endpoint on it — a Swarm service on another
 * node, say — which leaves it for next time rather than failing this one.
 */
function releaseIsolatedNetworkCommand(appName: string): string {
  const network = quote([appName]);
  const othersOnIt = `docker network inspect -f '{{range .Containers}}{{if ne .Name "cloudgate-traefik"}}{{.Name}} {{end}}{{end}}' ${network} 2>/dev/null`;
  const scope = `docker network inspect -f '{{.Scope}}' ${network} 2>/dev/null`;
  return `if [ "$(${scope})" = local ] && [ -z "$(${othersOnIt})" ]; then
		docker network disconnect ${network} cloudgate-traefik >/dev/null 2>&1 || true;
		docker network rm ${network} >/dev/null 2>&1 || true;
	fi`;
}

/**
 * How long a compose deploy waits for a Swarm stack of the same name to finish
 * going before it gives up, in polls of {@link KIND_SWITCH_POLL_SECONDS}.
 * Two minutes: `docker stack rm` returns on acceptance and a task's stop grace
 * period is 10 s by default, so a stack still holding its network after this
 * is stuck on something an operator has to look at.
 */
const KIND_SWITCH_POLLS = 60;
const KIND_SWITCH_POLL_SECONDS = 2;

/**
 * What a deploy does about the **other** kind of this stack before it brings
 * this one up: a Swarm stack deploy takes down a Docker Compose project
 * of the same name, and a Docker Compose deploy takes down a Swarm stack of the
 * same name, network included.
 *
 * **Why it is needed.** "Applied as" is a `PATCH` away (`updateComposeSchema`
 * keeps it mutable, for H-87's reason), and a Compose project and a Swarm stack
 * of one name are different objects to Docker that collide on one name:
 * `<appName>_default`. Stop on a Compose project is `docker compose stop`,
 * which keeps that bridge, so the stack deploy that followed the Advanced
 * card's old "stop, change, deploy" failed with `network with name
 * <appName>_default already exists` — and nothing on screen could remove it,
 * because Stop on a stack is `docker stack rm`. The reverse is the same shape:
 * `docker compose up` refuses an existing `<appName>_default` that lacks its
 * own labels.
 *
 * **How it knows the previous kind: it asks the daemon, by label, every
 * deploy** — nothing is recorded on the row, so no migration. A `stack deploy`
 * labels its services and networks `com.docker.stack.namespace=<appName>` and
 * a `compose up` labels its containers and networks
 * `com.docker.compose.project=<appName>`; neither sets the other's
 * (`composeTeardownCommand` measured this), and `appName` is unique across the
 * compose table. A recorded "last deployed kind" was rejected: it is the
 * H-87 mistake again — a column standing in for the daemon — and it would be
 * wrong for exactly the rows that need this most: a first switch that already
 * failed (the row reads `stack`, the Compose project is still up), a restore,
 * an import. Asking costs two reads on a deploy that has nothing to remove,
 * and logs nothing.
 *
 * **What goes and what stays.** Containers, tasks and the kind's own networks
 * go; **volumes stay** — no `--volumes`, and `docker stack rm` has no volume
 * flag — so a named volume is taken over by the new kind under the same
 * `<appName>_<volume>` name (Compose warns that it did not create it and uses
 * it). The old kind is running until this point, so a switch is one Deploy and
 * no Stop; the stack is down between the removal and the new kind's start.
 *
 * **The compose `down` runs from `/`**, not the project directory: with a file
 * in the working directory `compose down` would parse the *new* kind's file,
 * which is not what it is removing; with none it removes by project label.
 *
 * **The stack removal waits** until no service or network of the stack is left,
 * re-issuing `docker stack rm` each poll, because the first one returns before
 * the tasks have drained and fails to remove a network they still hold. It
 * reads the network by label rather than node-local containers, so the answer
 * is cluster-wide. On a node that is not a swarm manager both reads are empty
 * and nothing runs.
 *
 * **A custom deploy command is left alone.** It is the operator's own
 * replacement for the generated arguments and decides for itself which kind it
 * deploys, so taking down "the other kind" by `composeType` could take down
 * what it just deployed on every deploy.
 *
 * Every `$(…)` is double-quoted, so the whole script still parses as words
 * (the `expectQuotedInCommand` pin), and failures exit explicitly: the script
 * body sits on the left of `||`, where `set -e` does not apply.
 */
function removeOtherComposeKindCommand(
  compose: Pick<DeployableComposeSource, 'appName' | 'composeType' | 'command'>,
): string {
  if (compose.command) return '';
  const { appName } = compose;
  const name = quote([appName]);
  const docker = 'env -i PATH="$PATH" docker';

  if (compose.composeType === 'stack') {
    const label = `label=com.docker.compose.project=${name}`;
    const present = `"$(${docker} ps -aq --filter ${label} 2>/dev/null)$(${docker} network ls -q --filter ${label} 2>/dev/null)"`;
    return `if [ -n ${present} ]; then
		echo ${quote([`Removing the Docker Compose project ${appName} (containers and network; volumes stay) before deploying it as a Swarm stack`])};
		cd / && ${docker} compose -p ${name} down 2>&1 || { echo ${quote([`Error: ❌ Could not remove the Docker Compose project ${appName}; the Swarm stack was not deployed`])}; exit 1; };
	fi`;
  }

  const label = `label=com.docker.stack.namespace=${name}`;
  const present = `"$(${docker} service ls -q --filter ${label} 2>/dev/null)$(${docker} network ls -q --filter ${label} 2>/dev/null)"`;
  return `if [ -n ${present} ]; then
		echo ${quote([`Removing the Swarm stack ${appName} (services and network; volumes stay) before deploying it with Docker Compose`])};
		tries=0;
		while [ -n ${present} ]; do
			if [ "$tries" -ge ${KIND_SWITCH_POLLS} ]; then
				echo ${quote([`Error: ❌ The Swarm stack ${appName} is still there after ${KIND_SWITCH_POLLS * KIND_SWITCH_POLL_SECONDS}s of removing it; the Docker Compose project was not deployed. Check docker stack ps ${appName}, then deploy again`])};
				exit 1;
			fi;
			${docker} stack rm ${name} >/dev/null 2>&1 || true;
			tries="$((tries + 1))";
			sleep ${KIND_SWITCH_POLL_SECONDS};
		done;
	fi`;
}

/**
 * The deploy's half of routing a `stack` Compose's Domains: write the
 * file-provider config `createComposeStackTraefikConfig` builds to
 * `dynamic/compose+<appName>.yml` on the stack's Server, or remove it.
 *
 * `DomainsService` rewrites the same file through
 * `TraefikAppConfigService.routeComposeStack` whenever a Domain changes, the
 * way an Application's is. The deploy writes it too because the deploy is
 * where a Compose becomes a stack: "Applied as" is a `PATCH` away and takes
 * effect here (`removeOtherComposeKindCommand`), and a stack routed by labels
 * earlier has no file until something writes one. Same builder, same
 * `yaml` `stringify` and the same base64 write the writer uses remotely, so
 * the two agree to the byte.
 *
 * **Removed for everything else**: a stack with no routed Domain, and every
 * `docker-compose` deploy, whose labels route it — a file left from its days as
 * a stack would put a second router on its hosts, aimed at a Swarm service the
 * deploy just took down. The name is one only a Compose can own
 * (`composeStackConfigName`), so the `rm -f` can never reach an Application's
 * file.
 */
export function composeStackRoutingCommand(
  compose: Pick<
    DeployableComposeSource,
    'appName' | 'composeType' | 'serverId'
  >,
  domains: ComposeDomain[],
): string {
  const path = dynamicTraefikConfigPath(
    composeStackConfigName(compose.appName),
    compose.serverId,
  );
  if (compose.composeType !== 'stack' || domains.length === 0) {
    return `rm -f ${quote([path])}`;
  }
  const config = createComposeStackTraefikConfig(compose.appName, domains);
  return `${writeComposeFileCommand(path, stringify(config))} || { echo ${quote([`Error: ❌ Could not write the Traefik routing for stack ${compose.appName}`])}; exit 1; }`;
}

/**
 * The environment variable a traced Compose's deploy program reads its
 * converted file from: the file carries the Service's ingest
 * credential, so it travels in the program's environment, never its text,
 * which `ps` can read — `CG_TRACE_STORE_CONFIG`'s rule.
 */
export const COMPOSE_FILE_VARIABLE = 'CG_COMPOSE_FILE';

/**
 * The environment variable every Compose's deploy program reads its `.env`
 * from, on {@link COMPOSE_FILE_VARIABLE}'s rule: the file is every
 * generated secret and the operator's own values.
 */
export const COMPOSE_ENV_VARIABLE = 'CG_COMPOSE_ENV';

/**
 * The environment variable a stack's deploy program reads its variables'
 * `export` script from, which the stack deploy's shell reads off a
 * pipe rather than its argv ({@link getBuildComposeCommand}).
 */
export const COMPOSE_STACK_ENV_VARIABLE = 'CG_COMPOSE_STACK_ENV';

/**
 * The most one `NAME=value` string may be at `exec` on Linux: MAX_ARG_STRLEN,
 * 32 pages, terminating NUL included. The platform host runs a deploy program
 * with `execAsync`, so a payload over it would fail as E2BIG; a Server takes
 * the environment over `sh -s`'s stdin and has no such cap.
 */
export const PLATFORM_ENV_STRING_LIMIT = 128 * 1024;

/** What a deploy log calls each payload, for the one line that refuses it. */
const PROGRAM_ENV_PAYLOADS: Record<string, string> = {
  [COMPOSE_ENV_VARIABLE]: '.env is',
  [COMPOSE_STACK_ENV_VARIABLE]: 'stack variables are',
  [COMPOSE_FILE_VARIABLE]: 'converted file is',
};

/**
 * Refuses, before `exec`, a platform-host deploy whose environment carries a
 * string the kernel would refuse, in a sentence the Deployment's log
 * and notification can carry — rather than E2BIG from a spawn, which names
 * neither the file nor the limit. Nothing is truncated or sent another way.
 */
function assertPlatformEnvFits(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    const bytes = Buffer.byteLength(`${name}=${value}`) + 1;
    if (bytes > PLATFORM_ENV_STRING_LIMIT) {
      throw new Error(
        `The Compose's ${PROGRAM_ENV_PAYLOADS[name] ?? `${name} is`} ${Math.ceil(bytes / 1024)} KiB; the limit is ${PLATFORM_ENV_STRING_LIMIT / 1024} KiB on the platform host. Move the large values into files the stack mounts, or deploy it to a Server.`,
      );
    }
  }
}

/** A deploy program, and the environment it reads values out of. */
export interface ComposeBuildProgram {
  command: string;
  /**
   * The `.env` always ({@link COMPOSE_ENV_VARIABLE}), a stack's variables
   * ({@link COMPOSE_STACK_ENV_VARIABLE}) and a traced Compose's converted
   * file ({@link COMPOSE_FILE_VARIABLE}).
   */
  env: Record<string, string>;
}

/**
 * {@link getBuildComposeCommand}, with the environment its program needs:
 * every value the program writes or hands `docker` is carried here rather
 * than as a payload in its text, which `ps` reads. Throws, for a
 * platform-host deploy, when one of them is over
 * {@link PLATFORM_ENV_STRING_LIMIT}.
 */
export function getBuildComposeProgram(
  compose: DeployableComposeSource,
  composeContent: string,
  domains: ComposeDomain[],
  traces: ComposeTraceWiring | null = null,
): ComposeBuildProgram {
  const env: Record<string, string> = {
    [COMPOSE_ENV_VARIABLE]: composeEnvFileContent(compose),
  };
  const stackEnv =
    compose.composeType === 'stack' ? composeStackEnv(compose) : null;
  if (stackEnv) env[COMPOSE_STACK_ENV_VARIABLE] = stackEnv.script;
  if (traces) {
    env[COMPOSE_FILE_VARIABLE] = injectComposeTraceWiring(
      writeDomainsToCompose(compose, composeContent, domains),
      traces,
    );
  }
  if (stackRootId(compose) === null) assertPlatformEnvFits(env);
  return {
    command: getBuildComposeCommand(
      compose,
      composeContent,
      domains,
      traces,
      stackEnv?.skipped ?? [],
    ),
    env,
  };
}

/**
 * Writes the domain-injected compose file and .env, then runs the deploy
 * command from the project directory under `env -i` so host variables never
 * leak into the stack. Isolated deployments get their own attachable (overlay
 * for stacks) network with the traefik container connected to it. A stack's
 * Domains are then routed by {@link composeStackRoutingCommand}, once the
 * services it names exist.
 *
 * The program reads the `.env` and a stack's variables out of its environment
 * ({@link getBuildComposeProgram}), which is the only way it is run.
 * `skippedStackKeys` are the keys that environment had to leave out, which the
 * program warns about; {@link getBuildComposeProgram} passes the ones it
 * computed with the script, so a stack's variables are read once per deploy.
 */
export function getBuildComposeCommand(
  compose: DeployableComposeSource,
  composeContent: string,
  domains: ComposeDomain[],
  traces: ComposeTraceWiring | null = null,
  skippedStackKeys: readonly string[] = compose.composeType === 'stack'
    ? composeStackEnv(compose).skipped
    : [],
): string {
  const { appName, composeType, isolatedDeployment } = compose;
  const composeFilePath = getComposeFilePath(compose);
  const projectPath = join(
    composeDirectoryOn(stackRootId(compose)),
    appName,
    'code',
  );

  // A traced Compose's wiring goes in here and nowhere upstream of it:
  // `writeDomainsToCompose` also answers `GET /compose/:id/converted`, and the
  // header carries the Service's ingest credential — which is why a traced
  // file is written from the program's environment ({@link
  // getBuildComposeProgram}) and never appears in this text. The file is made
  // owner-only before a byte reaches it, as the Trace store's config is.
  const writeComposeCommand = traces
    ? `touch ${quote([composeFilePath])} && chmod 600 ${quote([composeFilePath])} && printf '%s' "$${COMPOSE_FILE_VARIABLE}" > ${quote([composeFilePath])};`
    : `${writeComposeFileCommand(
        composeFilePath,
        writeDomainsToCompose(compose, composeContent, domains),
      )};`;

  // A stack's variables reach `docker stack deploy`'s environment through a
  // pipe: `printf` is the shell's builtin, so no process's argv holds
  // them, and the inner shell under `env -i` `eval`s the `export`s off its
  // stdin — so `env -i` still keeps the host's variables, and the payload's
  // own, out of the stack.
  const docker = `docker ${createComposeCommand(compose)}`;
  const dockerCommand =
    composeType === 'stack'
      ? `printf '%s' "$${COMPOSE_STACK_ENV_VARIABLE}" | env -i PATH="$PATH" HOME="$HOME" sh -c ${quote([`eval "$(cat)" && exec ${docker} < /dev/null`])}`
      : `env -i PATH="$PATH" HOME="$HOME" ${docker}`;
  const skippedStackKeyWarnings = skippedStackKeys
    .map(
      (key) =>
        `echo ${quote([`Warning: ${key} is not a shell variable name, so docker stack deploy is not given it`])};`,
    )
    .join('\n\t');

  return `
set -e
{
	echo ${quote([`Deploying compose ${appName} (${composeType}) 🐳`])};
	${skippedStackKeyWarnings}

	${writeComposeCommand}

	${getCreateComposeEnvFileCommand(compose)}

	${removeOtherComposeKindCommand(compose)}

	cd ${quote([projectPath])};

	${
    // An isolated Compose project's `<appName>` is a local bridge, which a
    // stack cannot use as its external network; with the project just taken
    // down only Traefik is left on it, so it is released and made an overlay.
    isolatedDeployment && composeType === 'stack' && !compose.command
      ? releaseIsolatedNetworkCommand(appName)
      : ''
  }
	${
    isolatedDeployment
      ? `docker network inspect ${quote([appName])} >/dev/null 2>&1 || docker network create ${composeType === 'stack' ? '--driver overlay ' : ' '}--attachable ${quote([appName])}`
      : ''
  }
	${
    // The store's network is external to the file, and a store that could
    // not be started did not make it: made here too, so a traced Compose
    // deploys whatever its store did.
    traces ? ensureTraceStoreNetworkCommand(appName) : ''
  }
	${dockerCommand} 2>&1 || { echo "Error: ❌ Docker command failed"; exit 1; }
	${
    isolatedDeployment
      ? `docker network connect ${quote([appName])} $(docker ps --filter "name=cloudgate-traefik" -q) >/dev/null 2>&1`
      : releaseIsolatedNetworkCommand(appName)
  }
	${composeStackRoutingCommand(compose, domains)};

	echo "Docker Compose Deployed: ✅";
} || {
	echo "Error: ❌ Script execution failed";
	exit 1
}
`;
}
