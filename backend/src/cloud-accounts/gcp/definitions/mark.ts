import { idKey } from './names';
import type { StateMark } from '../../aws/definitions/tags';

/**
 * Cloudgate's mark on what it makes in Google Cloud (the Google Cloud spec, "Names,
 * labels and the mark"; S4, S5). The fixed name ({@link ./names}) is the
 * mark itself; the labels and the description add to it where a kind takes
 * them.
 */

/**
 * The label keys (S5). AWS's `cloudgate:` keys cannot be reused: Google's
 * label keys and values allow only lowercase letters, digits, `_` and `-`.
 * There is no address label: the fixed name already says which address in
 * the state a thing is.
 */
export const LABEL_KEYS = {
  cloudAccount: 'cloudgate-cloud-account',
  environment: 'cloudgate-environment',
  state: 'cloudgate-state',
} as const;

/**
 * The labels of one state's things, valued by the ids' keys: an id may hold
 * capitals, which a label value refuses. Written on each kind whose resource
 * has `labels` rather than through the provider's `default_labels`, so the
 * definition itself says which kinds carry them.
 */
export function stateLabels(mark: StateMark): Record<string, string> {
  return {
    [LABEL_KEYS.cloudAccount]: idKey(mark.cloudAccountId),
    [LABEL_KEYS.environment]: idKey(mark.environmentId),
    [LABEL_KEYS.state]: idKey(mark.stateId),
  };
}

/**
 * The `description` every kind Cloudgate makes carries: the unencoded ids,
 * which a key cannot be turned back into. Before adopting a thing found by
 * its name, Cloudgate checks its description is exactly this; a name with
 * another description is "found, not Cloudgate's" and never adopted (S4).
 */
export function markDescription(mark: StateMark): string {
  return `Cloudgate cloud-account=${mark.cloudAccountId} environment=${mark.environmentId} state=${mark.stateId}`;
}
