import {
  gcpBucketKeyAddress,
  otherKeySlot,
} from '../cloud-accounts/gcp/definitions/bucket-definition';
import type { GcpBucketKeys } from '../cloud-accounts/gcp/definitions/bucket-definition';
import type { Bucket, BucketRotationKeys } from './bucket.schema';

/**
 * What a bucket on Cloud Storage's state holds of its keys, read off
 * its row, so that every definition of it — a plan's read, a create's or
 * change's Cloud run, a Rotate key's runs — writes the keys its state holds
 * and none other:
 *
 * - the live key is in {@link Bucket.googleKeySlot} (the first slot unless
 *   a rotation moved it);
 * - the other slot holds a key while a rotation keeps one apart from the
 *   stored one: its new key while it redeploys, or a key it could not
 *   destroy (a stray), which the next rotation destroys first.
 */
export function googleKeyLayout(
  row: Pick<Bucket, 'googleKeySlot'> & {
    readonly rotationKeys: BucketRotationKeys | null;
  },
): GcpBucketKeys {
  const keys = row.rotationKeys;
  return {
    live: row.googleKeySlot ?? 'key',
    spare:
      keys !== null && (keys.newKey !== null || keys.strayKeyIds.length > 0),
  };
}

/**
 * The addresses of the keys a bucket's state holds, as
 * {@link googleKeyLayout} reads them: the live key's slot, and the other
 * slot too while it holds a spare. A Delete's destroy limited to its key and
 * account names these, so no key a rotation moved or holds apart
 * outlives it.
 */
export function googleKeyAddresses(keys: GcpBucketKeys): string[] {
  return keys.spare
    ? [
        gcpBucketKeyAddress(keys.live),
        gcpBucketKeyAddress(otherKeySlot(keys.live)),
      ]
    : [gcpBucketKeyAddress(keys.live)];
}
