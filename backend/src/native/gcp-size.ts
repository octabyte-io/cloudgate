import type { CloudRunPair } from '../cloud-accounts/gcp/definitions/cloud-run-definition';
import { CLOUD_SQL_INSTANCE_ADDRESS } from '../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { MEMORYSTORE_INSTANCE_ADDRESS } from '../cloud-accounts/gcp/definitions/memorystore-definition';
import type { NativeGcpBlock } from './gcp-native';
import { GCP_CONTAINER_ADDRESS } from './google-locks';
import type { PathPart } from './provider-schema';
import { cloudRunPairProblem } from '../cloud-accounts/gcp/definitions/cloud-run-size';
import {
  nativePairRefusal,
  nativeSizeOf,
  pairWording,
  sizeBearingAt,
} from './size-override';
import type { SizeBearingTable } from './size-override';

/**
 * **Exact sizes on Google Cloud** (ADR-0044 rule 12): the twin of
 * `aws-size.ts`, the size-bearing arguments a `native.gcp` block may set,
 * each open on the lock list (`google-open-settings.ts`), and how a plan
 * reads what they set. The rules every cloud shares are
 * `size-override.ts`'s.
 *
 * - `settings.tier` on a postgres's Cloud SQL instance, and `node_type` on
 *   a redis's Memorystore instance, the whole machine; its size line names
 *   its CPU and memory when the planner's committed table knows it
 *   (`cloud-sql.ts`, `memorystore.ts`).
 * - The Cloud Run container's `resources.limits` `cpu` and `memory`, each
 *   half of the pair a `web` runs at, so one alone overrides that half and
 *   the size keeps the other (`api medium → 4 CPU (native) / 2 GB`).
 *
 * A Worker's worker pool is not laid yet (`gcp-lay.ts`), so its limits are
 * not here.
 */
const LIMITS = ['template', 'containers', 'resources', 'limits'] as const;

export const GCP_SIZE_BEARING: SizeBearingTable = {
  prefix: 'native.gcp',
  settings: [
    {
      address: CLOUD_SQL_INSTANCE_ADDRESS,
      path: ['settings', 'tier'],
      part: 'machine',
    },
    {
      address: MEMORYSTORE_INSTANCE_ADDRESS,
      path: ['node_type'],
      part: 'machine',
    },
    { address: GCP_CONTAINER_ADDRESS, path: [...LIMITS, 'cpu'], part: 'cpu' },
    {
      address: GCP_CONTAINER_ADDRESS,
      path: [...LIMITS, 'memory'],
      part: 'memory',
    },
  ],
};

/** Whether `path` of `address` is a size-bearing argument on Google Cloud. */
export function isGcpSizeBearing(
  address: string,
  path: readonly PathPart[],
): boolean {
  return sizeBearingAt(GCP_SIZE_BEARING, address, path) !== undefined;
}

const text = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : null;

/** The Cloud SQL tier `block` sets natively, or `null` where it leaves it to `size`. */
export function nativeTierOf(
  block: NativeGcpBlock | null | undefined,
): string | null {
  return text(
    nativeSizeOf(GCP_SIZE_BEARING, block, CLOUD_SQL_INSTANCE_ADDRESS, 'machine')
      ?.value,
  );
}

/** The Memorystore node type `block` sets natively, or `null`. */
export function nativeMemorystoreNodeTypeOf(
  block: NativeGcpBlock | null | undefined,
): string | null {
  return text(
    nativeSizeOf(
      GCP_SIZE_BEARING,
      block,
      MEMORYSTORE_INSTANCE_ADDRESS,
      'machine',
    )?.value,
  );
}

/**
 * A Cloud Run `cpu` limit as Google takes it, in CPUs: `"4"`, `4` or
 * `"4000m"`. `undefined` for anything else, which Google judges at deploy.
 */
function cpuOf(value: unknown): number | undefined {
  if (typeof value === 'number') return value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const found = /^\s*(\d+(?:\.\d+)?)(m)?\s*$/.exec(value);
  if (!found) return undefined;
  const count = found[2] ? Number(found[1]) / 1000 : Number(found[1]);
  return count > 0 ? count : undefined;
}

/** A Cloud Run `memory` limit in MiB: `"512Mi"`, `"4Gi"`, `"4G"`. */
function memoryMbOf(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const found = /^\s*(\d+(?:\.\d+)?)\s*(Mi|Gi|M|G)\s*$/.exec(value);
  if (!found) return undefined;
  const amount = Number(found[1]);
  const mb = found[2].startsWith('G') ? amount * 1024 : amount;
  return mb > 0 ? mb : undefined;
}

/** The halves of a Cloud Run pair `block` sets natively, each absent where it sets none. */
export function nativeCloudRunOf(block: NativeGcpBlock | null | undefined): {
  readonly cpu?: number;
  readonly memoryMb?: number;
} {
  const cpu = cpuOf(
    nativeSizeOf(GCP_SIZE_BEARING, block, GCP_CONTAINER_ADDRESS, 'cpu')?.value,
  );
  const memoryMb = memoryMbOf(
    nativeSizeOf(GCP_SIZE_BEARING, block, GCP_CONTAINER_ADDRESS, 'memory')
      ?.value,
  );
  return {
    ...(cpu === undefined ? {} : { cpu }),
    ...(memoryMb === undefined ? {} : { memoryMb }),
  };
}

/** Whether `block` sets either half of a Cloud Run pair. */
export function setsCloudRunPair(
  block: NativeGcpBlock | null | undefined,
): boolean {
  const native = nativeCloudRunOf(block);
  return native.cpu !== undefined || native.memoryMb !== undefined;
}

/** The pair a `web` runs at on Cloud Run: native's halves over the size's. */
export function cloudRunPairWith(
  pair: CloudRunPair,
  block: NativeGcpBlock | null | undefined,
): CloudRunPair {
  const native = nativeCloudRunOf(block);
  return {
    cpu: native.cpu ?? pair.cpu,
    memoryMb: native.memoryMb ?? pair.memoryMb,
  };
}

/**
 * A container pair `block` lays that Cloud Run does not run,
 * refused at plan time by the native paths that set it, or `null` when
 * native sets neither half or the pair is one Cloud Run runs
 * (`cloudRunPairProblem`). `pair` is what it runs at without native: the
 * size's, or with no size the caps it has.
 */
export function nativeCloudRunRefusal(
  name: string,
  pair: CloudRunPair,
  block: NativeGcpBlock | null | undefined,
): { readonly at: string; readonly message: string } | null {
  const native = nativeCloudRunOf(block);
  const parts = [
    ...(native.cpu === undefined ? [] : ['cpu' as const]),
    ...(native.memoryMb === undefined ? [] : ['memory' as const]),
  ];
  return nativePairRefusal(
    GCP_SIZE_BEARING,
    name,
    block,
    GCP_CONTAINER_ADDRESS,
    parts,
    parts.length === 0
      ? null
      : cloudRunPairProblem(cloudRunPairWith(pair, block)),
  );
}

/** `512 MB`, `4 GB`: memory as a Cloud Run plan line shows it. */
function memoryText(memoryMb: number): string {
  return memoryMb % 1024 === 0 ? `${memoryMb / 1024} GB` : `${memoryMb} MB`;
}

/**
 * The pair a `web` runs at as its size line words it: native's
 * halves over the size's, each native one marked, `4 CPU (native) / 2 GB`.
 */
export function cloudRunWording(
  pair: CloudRunPair,
  block: NativeGcpBlock | null | undefined,
): string {
  const native = nativeCloudRunOf(block);
  const laid = cloudRunPairWith(pair, block);
  return pairWording(
    { text: `${laid.cpu} CPU`, native: native.cpu !== undefined },
    { text: memoryText(laid.memoryMb), native: native.memoryMb !== undefined },
  );
}

/**
 * A `web`'s caps after an Apply of `block`, for an entry with no
 * `size`, whose caps are Cloudgate's and the console's: the pair it runs
 * at, native's halves over the caps it has, so taking the native value out
 * later leaves it where it is rather than at Cloud Run's 1 CPU / 512 MB.
 * `null` when native sets neither half. In the columns' units: nano-CPUs
 * and bytes.
 */
export function capsWithNativeCloudRun(
  pair: CloudRunPair,
  block: NativeGcpBlock | null | undefined,
): { readonly cpuLimit: string; readonly memoryLimit: string } | null {
  if (!setsCloudRunPair(block)) return null;
  const laid = cloudRunPairWith(pair, block);
  return {
    cpuLimit: String(Math.round(laid.cpu * 1e9)),
    memoryLimit: String(Math.round(laid.memoryMb * 1024 * 1024)),
  };
}
