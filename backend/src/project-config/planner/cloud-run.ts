import {
  CLOUD_RUN_COPIES,
  cloudRunSize,
  formatCloudRunPair,
} from '../../cloud-accounts/gcp/definitions/cloud-run-size';
import type { CloudRunResource } from '../../cloud-accounts/gcp/definitions/cloud-run-definition';
import {
  cloudRunPairWith,
  cloudRunWording,
  nativeCloudRunRefusal,
  setsCloudRunPair,
} from '../../native/gcp-size';
import type { NativeGcpBlock } from '../../native/gcp-native';
import { savedSize } from './cloud-postgres';
import type { WebEntry } from '../project-config.types';
import type { CloudWebCreate, PlanRefusal } from './plan.types';

/** A change's size as it runs now: the caps the Service has, and whether the config moved it. */
export interface RunningSize {
  readonly changed: boolean;
  /** The Service's caps, nano-CPUs and bytes as its columns hold them. */
  readonly cpuLimit: string | null;
  readonly memoryLimit: string | null;
}

/**
 * The words a create on Cloud Run says of how it runs:
 * CPU is billed only while a request is served, and the copy range a
 * create writes (S10).
 */
const ON_CREATE = [
  'CPU only during requests',
  `${CLOUD_RUN_COPIES.min}–${CLOUD_RUN_COPIES.max} copies: scales to zero, so the first request after idle waits for a start`,
];

/**
 * The same for a Worker's Cloud Run worker pool: CPU is always
 * allocated, a worker pool's only billing, and its instance count is the
 * Service's `replicas`, with no automatic scaling in Google's GA worker pool.
 */
const ON_WORKER_CREATE = [
  'a worker pool: CPU always on, billed while its instances run',
  'its replicas are its instance count, with no automatic scaling',
];

/**
 * The same for a Cron service's Cloud Run job: billed only while an
 * execution runs, and each run is one execution Cloudgate's own timetable
 * starts, one task never retried.
 */
const ON_JOB_CREATE = [
  'a job: billed only while a run executes',
  "each run is one execution Cloudgate's timetable starts: one task, no retries",
];

/**
 * Why a worker pool's size was raised (as Cloud SQL's says). The
 * floor is Google's documented one for CPU that is always allocated, which a
 * worker pool's is: at least 1 CPU, and at least 512 MiB with it. It was
 * not measured live (the live check could not run: IAM refused Cloud Run
 * deploys), so the walk by hand confirms it (`docs/gcp-walk-by-hand.md`).
 */
const WORKER_ROUNDED =
  'a worker pool takes no less than 1 CPU / 512 MB, so the size was rounded up';

const NANO = 1e9;
const MB = 1024 * 1024;

/**
 * A `web`'s size on Cloud Run as its plan step says it (the Google Cloud spec, "Plan
 * behaviour"): the pair, what it was rounded up from, and on a create
 * the billing and copy range. A change says neither — they never move with
 * the config — but one whose new size lands on the pair the Service runs at
 * is still a change, and says "same on Cloud Run".
 *
 * The container's `resources.limits` `cpu` or `memory` its `native.gcp`
 * sets (ADR-0044 rule 12) wins over that half of the size's pair,
 * marked on the wording (`4 CPU (native) / 2 GB`); with no size, a made
 * Service's other half is the caps it has. `native` is the block the
 * Environment lays, none for any other.
 */
export function cloudRunSizeOf(
  name: string,
  entry: Pick<WebEntry, 'size'>,
  running?: RunningSize,
  resource: CloudRunResource = 'service',
  native?: NativeGcpBlock,
):
  | { readonly ok: true; readonly size: CloudWebCreate['size'] }
  | { readonly ok: false; readonly refusal: PlanRefusal } {
  // A worker pool takes the same pairs as a service with its CPU always
  // allocated: never under 1 CPU, so the same table rounds it.
  const sizing = cloudRunSize(name, entry.size);
  if (!sizing.ok) return sizing;
  const overridden = setsCloudRunPair(native);
  const base =
    overridden && !entry.size && running
      ? cloudRunSize(name, savedSize(running.cpuLimit, running.memoryLimit))
      : sizing;
  // A pair native lays that Cloud Run does not run is refused here, by its
  // native path, rather than by Google at deploy.
  const refused = nativeCloudRunRefusal(
    name,
    base.ok ? base.pair : sizing.pair,
    native,
  );
  if (refused) return { ok: false, refusal: refused };
  const pair = cloudRunPairWith(base.ok ? base.pair : sizing.pair, native);
  const wording = overridden
    ? cloudRunWording(base.ok ? base.pair : sizing.pair, native)
    : formatCloudRunPair(sizing.pair);
  const same =
    running?.changed === true &&
    pair.cpu * NANO === Number(running.cpuLimit) &&
    pair.memoryMb * MB === Number(running.memoryLimit);
  const onCreate =
    resource === 'worker-pool'
      ? [...(sizing.roundedUpFrom ? [WORKER_ROUNDED] : []), ...ON_WORKER_CREATE]
      : resource === 'job'
        ? ON_JOB_CREATE
        : ON_CREATE;
  const notes = running
    ? same
      ? [`same on Cloud Run: ${wording}`]
      : []
    : onCreate;
  return {
    ok: true,
    size: {
      name: sizing.sizeName,
      pair: {
        runsOn: 'Cloud Run',
        wording,
        // Rounded up only where the size's own pair runs.
        ...(sizing.roundedUpFrom && !overridden
          ? { roundedUpFrom: sizing.roundedUpFrom }
          : {}),
        ...(notes.length > 0 ? { notes } : {}),
      },
    },
  };
}
