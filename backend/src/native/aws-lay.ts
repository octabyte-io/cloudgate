import {
  AWS_ADDRESSES,
  AWS_DATA_HOLDING,
  awsAddressKey,
  AWS_CONTAINER_ADDRESS,
  CONTAINER_KEY,
} from './aws-locks';
import type { AwsMadeFacts } from './aws-locks';
import { nativeAwsCheck } from './aws-native';
import type { NativeAwsBlock } from './aws-native';
import type {
  NativeFieldDiff,
  NativeRefusal,
  ResourceBlocks,
} from './native-shared';
import {
  argumentLeaves,
  blamedMessage,
  layArguments,
  layObject,
  nativeLeafDiffs,
  objectLeaves,
  replaceRefusals,
  storedRefusal,
  valueAt,
} from './lay';
import type { NativeLeaf, NativeReading, PlannedResource } from './lay';
import { committedProvider } from './provider-schema';
import type { PathPart } from './provider-schema';
import type { ConfigKind } from '../project-config/planner/plan.types';

/**
 * **`native.aws` laid, planned and deployed** (ADR-0044 rules 3, 6 and
 * 9): what a cloud definition builder, the planner and the deploy call,
 * one function each, so every kind laid next (RDS and ElastiCache, S3
 * and CloudFront) adds itself by calling the same three:
 *
 * - **Lay.** {@link layNativeAws} lays a checked block over the `resource`
 *   object a builder wrote, before `main.tf.json` is written, by each
 *   address's committed `hashicorp/aws` schema (`lay.ts`). The ECS
 *   container (`container_definitions` on `aws_ecs_task_definition.service`)
 *   is merged into Cloudgate's one container in ECS's spelling, keeping its
 *   image, ports, secrets and log configuration.
 * - **Plan.** {@link nativeAwsDiffs} is the Service's native lines: each
 *   leaf the block lays that differs from what the applied block laid,
 *   path in the file's spelling, marked native, a side nothing writes shown
 *   as Cloudgate's own value for it (`default (none)` where it writes none).
 * - **Deploy.** {@link storedNativeAwsRefusal} fails a Deployment whose
 *   stored block now holds a locked value, naming it, and
 *   {@link blameNativeAws} names the native path AWS refused.
 * - **Replace.** {@link nativeAwsReplaceRefusals} refuses a native change the
 *   cloud plan carries out as a replace of what holds data, naming the path,
 *   so native never loses a bucket's files.
 *
 * Which kinds lay it is {@link laysNativeAws}: on any other a valid block is
 * still only checked, and nothing of it is planned or stored.
 */

/**
 * The kinds whose AWS definition lays `native.aws`: those the one ECS
 * builder makes, a `web`, a Private web service, a Worker
 * and a Cron service alike; a `bucket` on S3 and a `static` site on S3 and
 * CloudFront; a `postgres` and a `mysql` on RDS and a `redis` on
 * ElastiCache; a `compose` on its Stack VM (ADR-0070).
 */
const LAID_KINDS: ReadonlySet<ConfigKind> = new Set<ConfigKind>([
  'web',
  'web-private',
  'worker',
  'cron',
  'bucket',
  'static',
  'postgres',
  'mysql',
  'redis',
  'compose',
]);

/** Whether a kind's AWS definition lays `native.aws` yet. */
export function laysNativeAws(kind: string): boolean {
  return LAID_KINDS.has(kind as ConfigKind);
}

/** One resource's body, as the builders write it: an object. */
type Body = Readonly<Record<string, unknown>>;

/** The body a definition writes at an address, or `undefined`. */
function bodyAt(
  resources: ResourceBlocks | undefined,
  address: string,
): Body | undefined {
  const [type, local] = splitAddress(address);
  const body = resources?.[type]?.[local];
  return typeof body === 'object' && body !== null && !Array.isArray(body)
    ? (body as Body)
    : undefined;
}

/** An address's type and local name (`aws_ecs_service.service`). */
function splitAddress(address: string): [string, string] {
  const dot = address.indexOf('.');
  return [address.slice(0, dot), address.slice(dot + 1)];
}

/** The one container of a task definition's `container_definitions` JSON. */
function containerOf(body: Body | undefined) {
  const written = body?.[CONTAINER_KEY];
  if (typeof written !== 'string') return undefined;
  const parsed = JSON.parse(written) as unknown[];
  return parsed[0];
}

/**
 * `block` laid over a definition's `resource` object. Pure. Each
 * address must be one the definition writes: the plan refuses any other,
 * and a deploy refuses a stored one ({@link storedNativeAwsRefusal}), so
 * one here is Cloudgate's mistake and throws rather than being dropped.
 * With no block, `resources` is returned as it is, so a Service with none
 * writes exactly what it wrote before.
 */
export function layNativeAws<T extends ResourceBlocks>(
  resources: T,
  block: NativeAwsBlock | null | undefined,
): T {
  if (!block || Object.keys(block).length === 0) return resources;
  const provider = committedProvider('aws');
  const laid: Record<string, Record<string, unknown>> = Object.fromEntries(
    Object.entries(resources).map(([type, bodies]) => [type, { ...bodies }]),
  );
  for (const [address, native] of Object.entries(block)) {
    const [type, local] = splitAddress(address);
    const body = bodyAt(laid, address);
    const schema = provider.resource(type);
    if (!body || !schema) {
      throw new Error(
        `native.aws names ${address}, which this Service's definition does not write`,
      );
    }
    const { [CONTAINER_KEY]: container, ...rest } = native;
    const isContainer =
      address === AWS_CONTAINER_ADDRESS && Object.hasOwn(native, CONTAINER_KEY);
    const merged = withKept(
      address,
      body,
      native,
      layArguments(schema, body, isContainer ? rest : native),
    );
    if (isContainer) {
      merged[CONTAINER_KEY] = JSON.stringify([
        layObject(containerOf(body), container),
      ]);
    }
    laid[type][local] = merged;
  }
  return laid as unknown as T;
}

/**
 * Each item of a list the block writes, given Cloudgate's value of every
 * argument its address keeps (`AwsAddressEntry.kept`): a bucket's
 * every CORS rule written takes the origins its page trusts, read from the
 * one rule Cloudgate writes.
 */
function withKept(
  address: string,
  body: Body,
  native: Body,
  merged: Record<string, unknown>,
): Record<string, unknown> {
  const kept = AWS_ADDRESSES[awsAddressKey(address)]?.kept ?? {};
  for (const path of Object.keys(kept)) {
    const [list, field] = path.split('.');
    const written = merged[list];
    if (!Object.hasOwn(native, list) || !Array.isArray(written)) continue;
    const ours = valueAt(body, [list, 0, field]);
    merged[list] = written.map((item: unknown) =>
      typeof item === 'object' && item !== null && !Array.isArray(item)
        ? { ...item, [field]: ours }
        : item,
    );
  }
  return merged;
}

// ── Plan ──

/** One address's leaves, the container's by its own fields. */
function leavesOf(
  address: string,
  native: Readonly<Record<string, unknown>> | undefined,
): NativeLeaf[] {
  if (!native) return [];
  const [type] = splitAddress(address);
  const schema = committedProvider('aws').resource(type);
  const { [CONTAINER_KEY]: container, ...rest } = native;
  const isContainer =
    address === AWS_CONTAINER_ADDRESS && Object.hasOwn(native, CONTAINER_KEY);
  const args = isContainer ? rest : native;
  return [
    ...(schema
      ? argumentLeaves(schema, args)
      : objectLeaves(args).filter((leaf) => leaf.path.length > 0)),
    ...(isContainer ? objectLeaves(container, [CONTAINER_KEY]) : []),
  ];
}

/** Cloudgate's own value at one leaf, `undefined` where it writes none. */
function cloudgateAt(
  resources: ResourceBlocks | undefined,
  address: string,
  path: readonly PathPart[],
): unknown {
  const body = bodyAt(resources, address);
  if (address === AWS_CONTAINER_ADDRESS && path[0] === CONTAINER_KEY) {
    return valueAt(containerOf(body), path.slice(1));
  }
  return valueAt(body, path);
}

/** How the plan and the deploy read a `native.aws` block (`lay.ts`). */
const AWS_READING: NativeReading = {
  prefix: 'native.aws',
  refusedBy: 'AWS',
  leavesOf,
};

/**
 * The native lines of one Service's step: {@link nativeLeafDiffs}
 * over `native.aws`, a side with no native value read from `cloudgate`,
 * the definition the builder writes with no native block.
 */
export function nativeAwsDiffs(
  wanted: NativeAwsBlock | null | undefined,
  stored: NativeAwsBlock | null | undefined,
  cloudgate?: ResourceBlocks,
  consoleOwned: (address: string, path: readonly PathPart[]) => boolean = () =>
    false,
  sizeBorne: (address: string, path: readonly PathPart[]) => boolean = () =>
    false,
): NativeFieldDiff[] {
  return nativeLeafDiffs(
    AWS_READING,
    wanted,
    stored,
    (address, path) => cloudgateAt(cloudgate, address, path),
    consoleOwned,
    sizeBorne,
  );
}

// ── Replace ──

export type { PlannedResource } from './lay';

/**
 * **Losing data is refused by one rule**: each leaf of
 * `block` the cloud plan (`raw`, the read's AWS lines) carries out as a
 * replace of an address holding data ({@link AWS_DATA_HOLDING}), refused by
 * its full path, by the rule every cloud shares (`replaceRefusals` in
 * `lay.ts`).
 */
export function nativeAwsReplaceRefusals(
  configName: string,
  block: NativeAwsBlock | null | undefined,
  raw: readonly PlannedResource[],
): NativeRefusal[] {
  return replaceRefusals(AWS_READING, AWS_DATA_HOLDING, configName, block, raw);
}

// ── Deploy ──

/**
 * A stored `native.aws` that now holds a locked value, or one the provider
 * Cloudgate runs no longer has, fails its Service's Deployment naming each
 * (ADR-0044 rule 9): a value that predates the lock list never slips
 * through, and is never stripped. `null` when the block passes, or there
 * is none.
 */
export function storedNativeAwsRefusal(
  configName: string,
  kind: string,
  stored: NativeAwsBlock | null | undefined,
  facts: AwsMadeFacts,
): string | null {
  return storedRefusal(
    AWS_READING,
    nativeAwsCheck(configName, kind, stored ?? undefined, facts).refusals,
  );
}

/**
 * A value only AWS can judge (a grace period it rejects, a container field
 * it refuses) fails that Service's Deployment **naming the native path**
 * (ADR-0044 rule 5): when the refusal's words name a leaf the stored
 * block sets, in the provider's spelling or AWS's camelCase, the message
 * names each such path before AWS's own sentence. Any other refusal is
 * returned as it was.
 */
export function blameNativeAws(
  message: string,
  stored: NativeAwsBlock | null | undefined,
): string {
  return blamedMessage(AWS_READING, message, stored);
}
