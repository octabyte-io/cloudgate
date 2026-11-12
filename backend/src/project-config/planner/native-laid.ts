import { cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { laysNativeAws } from '../../native/aws-lay';
import { laysNativeGcp } from '../../native/gcp-lay';
import type { SavedService } from './plan.types';

/**
 * **Which cloud native block a Service lays, on every cloud** (ADR-0043's
 * reopen condition): one rule over a table of each
 * block's laid kinds, where `native-aws-lines.ts` and `native-gcp-lines.ts`
 * had one switch each. A cloud's block (`native.aws` on `aws`,
 * `native.gcp` on `gcp`) is laid only by a Service on that cloud, of a kind
 * its definition lays; on any other it is checked only.
 * Keyed by `cloud_kind`, so a cloud added to the enum is a type error here
 * until it says which kinds lay its block.
 */
const LAID_KINDS: { readonly [block in CloudKind]: (kind: string) => boolean } =
  {
    aws: laysNativeAws,
    gcp: laysNativeGcp,
  };

/** Whether a Service on `cloud` lays its entry's `native.<block>`. */
export function laysNativeOn(
  block: CloudKind,
  cloud: CloudKind | undefined,
  kind: string,
): boolean {
  return cloudOrLegacy(cloud) === block && LAID_KINDS[block](kind);
}

/**
 * Whether a saved Service's step compares its entry's `native.<block>`: an
 * Application's or a bucket's in a Cloud account, or a database's
 * Cloudgate made there, of a kind that lays it on its cloud. An existing
 * bucket has no cloud place, and an Existing database is used as given, so
 * Cloudgate makes nothing of either to lay a block over.
 */
export function comparesNative(
  block: CloudKind,
  found: SavedService,
  kind: string,
): boolean {
  if (found.cloud === undefined) return false;
  if (!laysNativeOn(block, found.cloud.cloud, kind)) return false;
  switch (found.serviceType) {
    case 'application':
    case 'bucket':
      return true;
    case 'postgres':
    case 'mysql':
    case 'redis':
      return found.serviceType === kind && found.existing === undefined;
    default:
      return false;
  }
}
