import type {
  NativeFieldDiff,
  NativeRefusal,
  ResourceBlocks,
} from './native-shared';
import { nativeGcpCheck } from './gcp-native';
import type { NativeGcpBlock } from './gcp-native';
import {
  GCP_ADDRESSES,
  GCP_CONTAINER_ADDRESS,
  GCP_CONTAINER_PATH,
  GCP_DATA_HOLDING,
  INGRESS,
} from './google-locks';
import type { GcpMadeFacts } from './google-locks';
import {
  argumentLeaves,
  blamedMessage,
  layArguments,
  nativeLeafDiffs,
  objectLeaves,
  replaceRefusals,
  storedRefusal,
  valueAt,
} from './lay';
import type { NativeLeaf, NativeReading, PlannedResource } from './lay';
import { blockAt, committedProvider, ownEntry } from './provider-schema';
import type { PathPart, SchemaBlock } from './provider-schema';
import type { ConfigKind } from '../project-config/planner/plan.types';

/**
 * **`native.gcp` laid, planned and deployed** (ADR-0044 rules 3, 6 and
 * 9): the Google twin of `aws-lay.ts`, by the same merge (`lay.ts`),
 * one function each for a definition builder, the planner and the deploy:
 *
 * - **Lay.** {@link layNativeGcp} lays a checked block over the `resource`
 *   object the Cloud Run builder wrote, before `main.tf.json` is written,
 *   by each address's committed schema of the provider its definition
 *   names. `template` merges field by field and `annotations` key by key;
 *   `volumes` and `cleanup_policies` replace whole. The container
 *   (`template.containers`, written as one object) is merged into
 *   Cloudgate's one container by the provider's container schema, so a
 *   `liveness_probe` keeps its image, ports and env. The Cloud SQL and
 *   Memorystore builders lay theirs the same way: Cloud SQL's
 *   `settings` merges field by field and its `database_flags` replaces
 *   whole; Memorystore's `engine_configs` merges key by key, so a
 *   `maxmemory-policy` keeps Cloudgate's other keys.
 * - **Plan.** {@link nativeGcpDiffs} is the Service's native lines, as on
 *   AWS, a setting the console owned handed back to it when taken out
 *   (`gcp-console-owned.ts`), and {@link closesRunApp} says whether
 *   a block closes a `web`'s `run.app` address, which the plan notes and
 *   the deploy stops reporting.
 * - **Deploy.** {@link storedNativeGcpRefusal} fails a Deployment whose
 *   stored block now holds a locked value, naming it, and
 *   {@link blameNativeGcp} names the native path Google refused.
 * - **Replace.** {@link nativeGcpReplaceRefusals} refuses a native change
 *   the cloud plan carries out as a replace of a Cloud SQL or Memorystore
 *   instance, naming the path, so native never loses data.
 *
 * Which kinds lay it is {@link laysNativeGcp}: on any other a valid block
 * is still only checked, and nothing of it is planned or stored.
 */

/**
 * The kinds whose Google definition lays `native.gcp`: a `web` on Cloud Run
 * a `postgres` on Cloud SQL and a `redis` on Memorystore,
 * a `mysql` on Cloud SQL, by `postgres`'s definition, and a `compose`
 * on its Stack VM (ADR-0070). A Private
 * web service, a Worker and a Cron service are made by the same builder,
 * but their native settings are slice 8's.
 */
const LAID_KINDS: ReadonlySet<ConfigKind> = new Set<ConfigKind>([
  'web',
  'postgres',
  'mysql',
  'redis',
  'compose',
]);

/** Whether a kind's Google definition lays `native.gcp` yet. */
export function laysNativeGcp(kind: string): boolean {
  return LAID_KINDS.has(kind as ConfigKind);
}

type Body = Readonly<Record<string, unknown>>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An address's type and local name (`google_cloud_run_v2_service.service`). */
function splitAddress(address: string): [string, string] {
  const dot = address.indexOf('.');
  return [address.slice(0, dot), address.slice(dot + 1)];
}

/** The committed schema of `address`, by the provider its definition names. */
function schemaOf(address: string): SchemaBlock | undefined {
  const entry = ownEntry(GCP_ADDRESSES, address);
  if (!entry) return undefined;
  return committedProvider(entry.provider).resource(entry.type);
}

/** The schema of the Cloud Run container, one of `template.containers`. */
function containerSchema(): SchemaBlock | undefined {
  const entry = GCP_ADDRESSES[GCP_CONTAINER_ADDRESS];
  return blockAt(
    committedProvider(entry.provider),
    entry.type,
    GCP_CONTAINER_PATH,
  );
}

/**
 * One address's native arguments with the container taken out of
 * `template`, where the file writes it as one object: the arguments the
 * schema lays, and the container, if any.
 */
function splitContainer(
  address: string,
  native: Body,
): { readonly args: Body; readonly container?: Body } {
  const [, inner] = GCP_CONTAINER_PATH;
  const template = native.template;
  if (
    address !== GCP_CONTAINER_ADDRESS ||
    !isObject(template) ||
    !Object.hasOwn(template, inner) ||
    !isObject(template[inner])
  ) {
    return { args: native };
  }
  const { [inner]: container, ...restOfTemplate } = template;
  const rest = Object.fromEntries(
    Object.entries(native).filter(([key]) => key !== 'template'),
  );
  return {
    args:
      Object.keys(restOfTemplate).length > 0
        ? { ...rest, template: restOfTemplate }
        : rest,
    container: container as Body,
  };
}

/** A block allowed once, as one object, whether written as one or as a list of one. */
function single(value: unknown): Record<string, unknown> | undefined {
  if (isObject(value)) return value;
  if (Array.isArray(value) && value.length === 1 && isObject(value[0])) {
    return value[0];
  }
  return undefined;
}

/**
 * `block` laid over a Google definition's `resource` object. Pure.
 * Each address must be one the definition writes: the plan refuses any
 * other, and a deploy refuses a stored one ({@link storedNativeGcpRefusal}),
 * so one here is Cloudgate's mistake and throws rather than being dropped.
 * With no block, `resources` is returned as it is, so a Service with none
 * writes exactly what it wrote before.
 */
export function layNativeGcp<T extends ResourceBlocks>(
  resources: T,
  block: NativeGcpBlock | null | undefined,
): T {
  if (!block || Object.keys(block).length === 0) return resources;
  const laid: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(resources).map(([type, bodies]) => [type, { ...bodies }]),
  );
  for (const [address, native] of Object.entries(block)) {
    const [type, local] = splitAddress(address);
    const body = laid[type]?.[local];
    const schema = schemaOf(address);
    if (!isObject(body) || !schema) {
      throw new Error(
        `native.gcp names ${address}, which this Service's definition does not write`,
      );
    }
    const { args, container } = splitContainer(address, native);
    const merged = layArguments(schema, body, args);
    if (container) merged.template = withContainer(merged.template, container);
    laid[type][local] = merged;
  }
  return laid as unknown as T;
}

/** Cloudgate's `template` with the native container merged into its one container. */
function withContainer(template: unknown, native: Body): unknown {
  const schema = containerSchema();
  const ours = single(template);
  if (!schema || !ours) {
    throw new Error(
      "native.gcp's container has no Cloud Run template to lay over",
    );
  }
  const [, inner] = GCP_CONTAINER_PATH;
  const containers = ours[inner];
  const one = Array.isArray(containers) ? single(containers) : undefined;
  if (!one) {
    throw new Error(
      "native.gcp's container has no Cloud Run container to lay over",
    );
  }
  const merged = { ...ours, [inner]: [layArguments(schema, one, native)] };
  return Array.isArray(template) ? [merged] : merged;
}

// ── Plan ──

/** One address's leaves, the container's by the container schema. */
function leavesOf(address: string, native: Body | undefined): NativeLeaf[] {
  if (!native) return [];
  const schema = schemaOf(address);
  const { args, container } = splitContainer(address, native);
  const inContainer = containerSchema();
  return [
    ...(schema
      ? argumentLeaves(schema, args)
      : objectLeaves(args).filter((leaf) => leaf.path.length > 0)),
    ...(container
      ? inContainer
        ? argumentLeaves(inContainer, container, GCP_CONTAINER_PATH)
        : objectLeaves(container, GCP_CONTAINER_PATH)
      : []),
  ];
}

/** How the plan and the deploy read a `native.gcp` block (`lay.ts`). */
const GCP_READING: NativeReading = {
  prefix: 'native.gcp',
  refusedBy: 'Google Cloud',
  leavesOf,
};

/**
 * The native lines of one Service's step: every leaf `wanted` lays
 * that differs from what `stored` (the block its last Apply laid) laid, a
 * side with no native value read from `cloudgate`, the definition the
 * builder writes with no native block. Its one container is read through
 * the list of one Cloudgate writes it as. A leaf `consoleOwned` says the
 * console owned is handed back to the console when taken out, and
 * one `sizeBorne` says is the entry's size's (`gcp-size.ts`) falls
 * back to the size, shown `size (<value>)`.
 */
export function nativeGcpDiffs(
  wanted: NativeGcpBlock | null | undefined,
  stored: NativeGcpBlock | null | undefined,
  cloudgate?: ResourceBlocks,
  consoleOwned: (address: string, path: readonly PathPart[]) => boolean = () =>
    false,
  sizeBorne: (address: string, path: readonly PathPart[]) => boolean = () =>
    false,
): NativeFieldDiff[] {
  return nativeLeafDiffs(
    GCP_READING,
    wanted,
    stored,
    (address: string, path: readonly PathPart[]) => {
      const [type, local] = splitAddress(address);
      return valueAt(cloudgate?.[type]?.[local], path);
    },
    consoleOwned,
    sizeBorne,
  );
}

/**
 * A native change Google's plan carries out as a replace of what holds
 * data (ADR-0044 rule 10): each leaf of `block` that forces a
 * replace of an address in {@link GCP_DATA_HOLDING}, refused by its full
 * path, by the one rule AWS's `nativeAwsReplaceRefusals` reads too.
 */
export function nativeGcpReplaceRefusals(
  configName: string,
  block: NativeGcpBlock | null | undefined,
  raw: readonly PlannedResource[],
): NativeRefusal[] {
  return replaceRefusals(GCP_READING, GCP_DATA_HOLDING, configName, block, raw);
}

/**
 * Whether a `native.gcp` closes a `web`'s `run.app` address: its Cloud Run
 * service's `ingress` is
 * `INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER`, so only its Domains, through
 * the Environment's load balancer, and the Environment itself reach it.
 */
export function closesRunApp(
  block: NativeGcpBlock | null | undefined,
): boolean {
  return (
    ownEntry(block ?? {}, GCP_CONTAINER_ADDRESS)?.ingress ===
    INGRESS.loadBalancer
  );
}

// ── Deploy ──

/**
 * A stored `native.gcp` that now holds a locked value, or one the provider
 * Cloudgate runs no longer has, fails its Service's Deployment naming each
 * (ADR-0044 rule 9), never stripped. `null` when the block passes,
 * or there is none.
 */
export function storedNativeGcpRefusal(
  configName: string,
  kind: string,
  stored: NativeGcpBlock | null | undefined,
  facts: GcpMadeFacts = {},
): string | null {
  return storedRefusal(
    GCP_READING,
    nativeGcpCheck(configName, kind, stored ?? undefined, facts).refusals,
  );
}

/**
 * A value only Google can judge (a concurrency Cloud Run rejects, a probe
 * it refuses) fails that Service's Deployment **naming the native path**
 * (ADR-0044 rule 5), in the provider's spelling or Google's
 * camelCase. Any other refusal is returned as it was.
 */
export function blameNativeGcp(
  message: string,
  stored: NativeGcpBlock | null | undefined,
): string {
  return blamedMessage(GCP_READING, message, stored);
}
