import { TAG_KEYS, tagAddress } from '../cloud-accounts/aws/definitions/tags';
import type {
  FoundResource,
  NoStateNote,
} from '../cloud-accounts/aws/plan-reader/read-plan';
import type { TaggedResource } from '../cloud-accounts/cloud.port';

/**
 * What one plan read's tag search found (the AWS spec "Recovery by tag"),
 * sorted by the state each find is tagged with:
 *
 * - `ours`: tagged with the state being read. The plan reader adopts one at
 *   an address the plan would create, and names any other as in no state.
 * - `strays`: tagged with a state Cloudgate has no record of — left by a
 *   Service an older backup does not know, or by a run cut off before its
 *   record was written. Never adopted into another state: each is a note,
 *   "found in AWS, in no state", for the operator to remove by hand.
 *
 * A find tagged with another state Cloudgate knows is that state's, and its
 * own read says what it is.
 */
export function sortFinds(
  found: readonly TaggedResource[],
  stateId: string,
  known: ReadonlySet<string>,
): { ours: FoundResource[]; strays: NoStateNote[] } {
  const ours: FoundResource[] = [];
  const strays: NoStateNote[] = [];
  for (const resource of found) {
    const state = resource.tags[TAG_KEYS.state];
    if (state === stateId) {
      ours.push(resource);
    } else if (state === undefined || !known.has(state)) {
      strays.push({
        arn: resource.arn,
        address: tagAddress(resource),
        line: `found in AWS, in no state: ${resource.arn}`,
      });
    }
  }
  return { ours, strays };
}

/** The notes with each ARN once, the reader's own first. */
export function withStrays(
  notes: readonly NoStateNote[],
  strays: readonly NoStateNote[],
): NoStateNote[] {
  const seen = new Set(notes.map((note) => note.arn));
  return [...notes, ...strays.filter((note) => !seen.has(note.arn))];
}
