/**
 * Who asked for a Requested preview, as an id: the one
 * resolution both readers of it share, the expiry sweep's platform audit row
 * and the Previews row's "Requested by". Pure, so neither reader imports the
 * other's service to get it.
 */

/** The fields of a preview's create audit row the resolution reads. */
export interface RequesterCreateRow {
  userId: string | null;
  metadata: string | null;
}

/**
 * The requester's id: **the preview's own column, then the create row's
 * metadata copy, then the create row's actor.** The column and the actor are
 * both `set null` when the requester is deleted, and the metadata copy is
 * not, which is why it sits between them. `null` when none of the three
 * names anybody.
 */
export function requesterIdOf(
  created: RequesterCreateRow | null,
  requesterId: string | null,
): string | null {
  return (
    requesterId ??
    recordedRequesterId(created?.metadata ?? null) ??
    created?.userId ??
    null
  );
}

/**
 * The requester id a create row's metadata carries. Both columns that
 * also name it — `preview_deployment.requester_id` and `audit_log.user_id` —
 * are `set null` when the requester is deleted, and this copy is not.
 * `metadata` is JSON text, so a row that is not JSON names nobody rather than
 * failing the sweep.
 */
export function recordedRequesterId(metadata: string | null): string | null {
  if (metadata === null) return null;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'requesterId' in parsed &&
      typeof parsed.requesterId === 'string'
    ) {
      return parsed.requesterId;
    }
  } catch {
    // Not JSON: no requester to copy.
  }
  return null;
}
