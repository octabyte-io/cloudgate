import { article } from '../messages.utils';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import type { PerCloud } from '../../cloud-accounts/cloud-provider';
import {
  cloudTarget,
  outputsOf,
  outputsWithoutValue,
} from '../outputs/outputs';
import type {
  ConfigLink,
  ConfigLinks,
  ProjectConfig,
  ServiceEntry,
} from '../project-config.types';
import type { DescribedEntry } from './fields';
import type {
  DeployTarget,
  FieldDiff,
  PlanInput,
  PlanNote,
  PlanRefusal,
  SavedService,
} from './plan.types';

/**
 * The planner's rules for **wired variables** (ADR-0031): which links
 * a plan refuses, and how a change of link reads in a change step. Pure, as
 * the planner is.
 *
 * A link `{ NAME: <service>.<output> }` on `web` is honoured only when the
 * source is a Service this config describes, of a kind that hands out that
 * Output where it runs, and where `web` can reach it — the same Server, or
 * the same cloud network. Links never form a loop, so an Apply always has
 * an order. Each refusal names the Service and the variable
 * (`web.env.DATABASE_URL`).
 */
export function linkRefusals(input: PlanInput): PlanRefusal[] {
  const { config } = input;
  const savedByName = new Map(
    input.saved.map((found) => [found.configName, found]),
  );
  const placeOf = placesOf(input);

  const refusals: PlanRefusal[] = [];
  const edges = new Map<string, Map<string, string>>();
  for (const [name, entry] of Object.entries(config.services)) {
    if (entry.managed === 'console') continue;
    for (const [variable, link] of Object.entries(entry.links ?? {})) {
      const refusal = linkRefusal(
        name,
        variable,
        link,
        config.services[link.source],
        savedByName.has(link.source),
        placeOf(name),
        placeOf(link.source),
      );
      if (refusal) {
        refusals.push(refusal);
        continue;
      }
      const out = edges.get(name) ?? new Map<string, string>();
      if (!out.has(link.source)) out.set(link.source, variable);
      edges.set(name, out);
    }
  }
  return [...refusals, ...loopRefusals(edges)];
}

function linkRefusal(
  name: string,
  variable: string,
  link: ConfigLink,
  source: ServiceEntry | undefined,
  sourceSaved: boolean,
  place: Place | null,
  sourcePlace: Place | null,
): PlanRefusal | null {
  const at = `${name}.env.${variable}`;
  const refuse = (because: string): PlanRefusal => ({
    at,
    message: `${at} links to ${linkText(link)}, but ${because}`,
  });

  if (!source) {
    return refuse(
      sourceSaved
        ? `this config no longer lists ${link.source}; link to it under the name the config now gives it, or remove the link`
        : `this config has no Service ${link.source}`,
    );
  }
  if (source.managed === 'console') {
    return refuse(
      `${link.source} is managed: console, and a console-managed Service hands out no Outputs`,
    );
  }
  if (!sourcePlace || !place) return null;
  const outputs = outputsOf(source.kind, {
    ca: sourcePlace.kind === 'cloud',
  });
  if (outputs.length === 0) {
    return refuse(
      `${link.source} is ${article(source.kind)}, which hands out no Outputs`,
    );
  }
  if (!outputs.includes(link.output)) {
    return refuse(
      `${article(source.kind)} ${describePlace(sourcePlace)} hands out no ${link.output}; it hands out ${outputs.join(', ')}`,
    );
  }
  if (!samePlace(place, sourcePlace)) {
    return refuse(
      `${name} runs ${describePlace(place)} and ${link.source} ${describePlace(sourcePlace)}, so ${name} cannot reach it; a link needs both on the same Server or in the same cloud network`,
    );
  }
  return null;
}

/**
 * A note for each variable linked to an Output that has no value where its
 * source runs: a bucket's key on AWS (ADR-0032), where the linking
 * task's own role gives access, warning that an app passing keys to its S3
 * client by hand breaks there; and a redis's password on Google Cloud
 * (ADR-0042), where Memorystore has none, saying plainly that its
 * network alone keeps others out, so any Service in the Environment can
 * connect. The plan does not refuse such a link; it says the variable is
 * left unset. Every plan that keeps the link says so, as long as it is
 * kept.
 */
export function roleAccessNotes(input: PlanInput): PlanNote[] {
  const placeOf = placesOf(input);
  const notes: PlanNote[] = [];
  for (const [name, entry] of Object.entries(input.config.services)) {
    if (entry.managed === 'console') continue;
    for (const [variable, link] of Object.entries(entry.links ?? {})) {
      const source = input.config.services[link.source];
      const sourcePlace = placeOf(link.source);
      if (!source || !sourcePlace) continue;
      if (sourcePlace.kind !== 'cloud') continue;
      const unset = outputsWithoutValue(
        source.kind,
        cloudTarget(sourcePlace.cloud),
      );
      if (!unset.includes(link.output)) continue;
      notes.push(
        source.kind === 'redis'
          ? {
              kind: 'no-password',
              configName: name,
              variable,
              message: `${name}.env.${variable} links to ${linkText(link)}: a redis on Memorystore has no password, so ${variable} is left unset. Only this Environment's private network reaches it, over TLS, so any Service in this Environment can connect to it, linked to it or not.`,
            }
          : {
              kind: 'task-role-access',
              configName: name,
              variable,
              message: `${name}.env.${variable} links to ${linkText(link)}: on AWS the task's role gives access, so ${variable} is left unset. An app that passes keys to its S3 client by hand breaks on AWS; let its SDK find its credentials by itself.`,
            },
      );
    }
  }
  return notes;
}

/**
 * **The checksum note's switch** (an open question of the Google Cloud buckets spec).
 * Newer S3 SDKs send checksums by default. A walk by hand tried it live: a
 * `web` on Cloud Run with `@aws-sdk/client-s3` 3.1161.0 and its default
 * checksums put, listed and fetched a presigned link on Cloud Storage with
 * the bucket's HMAC key, so the note stays built but **off**. If a later SDK
 * fails there, turning it on is this one line.
 */
export const BUCKET_CHECKSUM_NOTE_ON = false;

/**
 * What each cloud says of a variable linked to a bucket there about the S3
 * SDK's default checksums (ADR-0043): nothing on AWS, whose S3 takes them;
 * on Google Cloud, the two settings to set to `when_required`. Cloudgate
 * never sets either itself (ADR-0031): a variable is the app's own.
 */
const CHECKSUM_NOTES: PerCloud<
  ((name: string, variable: string, link: ConfigLink) => PlanNote) | null
> = {
  aws: null,
  gcp: (name, variable, link) => ({
    kind: 'bucket-checksums',
    configName: name,
    variable,
    message: `${name}.env.${variable} links to ${linkText(link)}: newer S3 SDKs send checksums Cloud Storage does not take. Set AWS_REQUEST_CHECKSUM_CALCULATION and AWS_RESPONSE_CHECKSUM_VALIDATION to when_required on ${name}; Cloudgate never sets them itself.`,
  }),
};

/**
 * A note for each variable linked to a bucket on Google Cloud, naming
 * `AWS_REQUEST_CHECKSUM_CALCULATION`,
 * `AWS_RESPONSE_CHECKSUM_VALIDATION` and `when_required`, while `on`, which
 * is {@link BUCKET_CHECKSUM_NOTE_ON} for every plan. Every plan that keeps
 * the link says so, as long as it is kept.
 */
export function bucketChecksumNotes(
  input: PlanInput,
  on: boolean = BUCKET_CHECKSUM_NOTE_ON,
): PlanNote[] {
  if (!on) return [];
  const placeOf = placesOf(input);
  const notes: PlanNote[] = [];
  for (const [name, entry] of Object.entries(input.config.services)) {
    if (entry.managed === 'console') continue;
    for (const [variable, link] of Object.entries(entry.links ?? {})) {
      const source = input.config.services[link.source];
      const sourcePlace = placeOf(link.source);
      if (source?.kind !== 'bucket' || sourcePlace?.kind !== 'cloud') continue;
      const note = byCloud(cloudOrLegacy(sourcePlace.cloud), CHECKSUM_NOTES);
      if (note) notes.push(note(name, variable, link));
    }
  }
  return notes;
}

/**
 * Where each Service the config describes runs, as far as reaching another
 * goes; `null` for a name it does not describe.
 */
function placesOf(input: PlanInput): (name: string) => Place | null {
  const savedByName = new Map(
    input.saved.map((found) => [found.configName, found]),
  );
  return (name) => {
    const entry = input.config.services[name];
    if (!entry || entry.managed === 'console') return null;
    const found = savedByName.get(name);
    // A Service keeps the place it was created in (ADR-0035); one this plan
    // creates, or re-creates as another kind, goes on the Deploy target.
    if (found && savedKindOf(found) === entry.kind) return savedPlace(found);
    return targetPlace(input.deployTarget, input.cloud);
  };
}

/** A source a Service may link to, and the Outputs it hands out there. */
export interface LinkableSource {
  readonly configName: string;
  readonly kind: string;
  readonly outputs: readonly string[];
}

/**
 * The sources `name` may link a variable to: every other Service the
 * config describes, of a kind that hands out Outputs where it runs, that
 * `name` can reach, and that does not already link back to `name` — so a
 * link picked from these is one {@link linkRefusals} accepts. Empty when
 * the config does not describe `name`.
 */
export function linkableSources(
  input: PlanInput,
  name: string,
): LinkableSource[] {
  const placeOf = placesOf(input);
  const place = placeOf(name);
  if (!place) return [];
  const linksBack = reachesBack(input.config.services, name);
  return Object.entries(input.config.services).flatMap(
    ([source, entry]): LinkableSource[] => {
      if (source === name || entry.managed === 'console') return [];
      const sourcePlace = placeOf(source);
      if (!sourcePlace || !samePlace(place, sourcePlace)) return [];
      if (linksBack.has(source)) return [];
      const outputs = outputsOf(entry.kind, {
        ca: sourcePlace.kind === 'cloud',
      });
      return outputs.length > 0
        ? [{ configName: source, kind: entry.kind, outputs }]
        : [];
    },
  );
}

/** Every Service whose links lead, through any others, to `name`. */
function reachesBack(
  services: ProjectConfig['services'],
  name: string,
): ReadonlySet<string> {
  const reaching = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [service, entry] of Object.entries(services)) {
      if (reaching.has(service) || entry.managed === 'console') continue;
      const sources = Object.values(entry.links ?? {}).map(
        (link) => link.source,
      );
      if (sources.some((source) => source === name || reaching.has(source))) {
        reaching.add(service);
        grew = true;
      }
    }
  }
  return reaching;
}

/**
 * Every loop of links, refused once at the link that closes it: an Apply
 * runs a source before what links to it, so a loop has no order.
 */
function loopRefusals(
  edges: ReadonlyMap<string, ReadonlyMap<string, string>>,
): PlanRefusal[] {
  const refusals: PlanRefusal[] = [];
  const seen = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string, path: string[]) => {
    if (done.has(name)) return;
    path.push(name);
    for (const [source, variable] of edges.get(name) ?? []) {
      const start = path.indexOf(source);
      if (start >= 0) {
        const loop = path.slice(start);
        const key = [...loop].sort().join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const at = `${name}.env.${variable}`;
        refusals.push({
          at,
          message: `${at} closes a loop of links (${[...loop, source].join(' → ')}); an Apply runs a source before what links to it, so one of these links has to go`,
        });
        continue;
      }
      visit(source, path);
    }
    path.pop();
    done.add(name);
  };
  for (const name of edges.keys()) visit(name, []);
  return refusals;
}

/**
 * A change step's lines for the links of one entry: each variable
 * whose applied link differs from the config's, as `env.<NAME>` from what
 * it was (a link, a typed value, or nothing) to what it will be. Never a
 * value (ADR-0019).
 */
export function linkChanges(
  entry: DescribedEntry,
  applied: ConfigLinks | undefined,
  heldEnv: readonly string[],
): FieldDiff[] {
  const wanted = entry.links ?? {};
  const had = applied ?? {};
  const held = new Set(heldEnv);
  const typed = new Set(entry.env);
  const diffs: FieldDiff[] = [];
  for (const variable of new Set([
    ...Object.keys(wanted),
    ...Object.keys(had),
  ])) {
    const from = Object.hasOwn(had, variable)
      ? linkText(had[variable])
      : held.has(variable)
        ? TYPED_VALUE
        : null;
    const to = Object.hasOwn(wanted, variable)
      ? linkText(wanted[variable])
      : typed.has(variable)
        ? TYPED_VALUE
        : null;
    if (from !== to) diffs.push({ field: `env.${variable}`, from, to });
  }
  return diffs;
}

/** A create step's lines for the links it starts with. */
export function linkCreates(entry: DescribedEntry): FieldDiff[] {
  return Object.entries(entry.links ?? {}).map(([variable, link]) => ({
    field: `env.${variable}`,
    from: null,
    to: linkText(link),
  }));
}

/** How a variable typed in Cloudgate reads in a plan line, never its value. */
export const TYPED_VALUE = 'typed value';

export function linkText(link: ConfigLink): string {
  return `${link.source}.${link.output}`;
}

// ── Places: where a Service runs, as far as reaching another goes ──

type Place =
  | { readonly kind: 'server'; readonly serverId: string }
  | { readonly kind: 'platform-host' }
  | {
      readonly kind: 'cloud';
      readonly cloudAccountId: string;
      readonly region: string;
      /** The Cloud account's cloud; absent is `aws`, as a plan's is. */
      readonly cloud?: CloudKind;
    };

function savedPlace(found: SavedService): Place {
  // An Existing database is reached in the Cloud account and region it is
  // looked up in, like a Service made there.
  // An existing bucket and an Existing cache likewise, and
  // a mysql's Existing database.
  if (
    (found.serviceType === 'postgres' ||
      found.serviceType === 'mysql' ||
      found.serviceType === 'redis' ||
      found.serviceType === 'bucket') &&
    found.existing
  ) {
    return {
      kind: 'cloud',
      cloudAccountId: found.existing.cloudAccountId,
      region: found.existing.region,
      // An existing bucket on Google Cloud, reached by its own key.
      ...(found.serviceType === 'bucket' && found.existing.cloud
        ? { cloud: found.existing.cloud }
        : {}),
    };
  }
  if (found.cloud) {
    return {
      kind: 'cloud',
      cloudAccountId: found.cloud.cloudAccountId,
      region: found.cloud.region,
      cloud: found.cloud.cloud,
    };
  }
  return found.serverId
    ? { kind: 'server', serverId: found.serverId }
    : { kind: 'platform-host' };
}

function targetPlace(target: DeployTarget, cloud?: CloudKind): Place {
  return target.kind === 'cloud' ? { ...target, cloud } : target;
}

/** The same Server, the platform host, or one cloud network (account and region). */
function samePlace(a: Place, b: Place): boolean {
  switch (a.kind) {
    case 'server':
      return b.kind === 'server' && a.serverId === b.serverId;
    case 'platform-host':
      return b.kind === 'platform-host';
    case 'cloud':
      return (
        b.kind === 'cloud' &&
        a.cloudAccountId === b.cloudAccountId &&
        a.region === b.region
      );
  }
}

function describePlace(place: Place): string {
  switch (place.kind) {
    case 'server':
      return `on Server ${place.serverId}`;
    case 'platform-host':
      return 'on the platform host';
    case 'cloud':
      return `in Cloud account ${place.cloudAccountId} (${place.region})`;
  }
}

/** A saved Service's kind as a config line names it. */
function savedKindOf(found: SavedService): string {
  return found.serviceType === 'application'
    ? found.settings.configKind
    : found.serviceType;
}
