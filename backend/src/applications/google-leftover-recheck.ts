/**
 * The second look of a Google Service Delete's leftover search.
 * Google's list calls trail a delete by a few seconds: a live walk saw the
 * search list the service account the destroy had removed a second
 * earlier, and the Environment Delete stopped as incomplete over it, which
 * a Retry then cleared. So a search that finds anything waits
 * {@link LEFTOVER_RECHECK_MS} and searches again, and only that second
 * search says what is left. A clean first search is not searched again.
 */
export interface LeftoverRecheckTimer {
  /** Resolves once `ms` have passed. */
  wait(ms: number): Promise<void>;
}

export const GOOGLE_LEFTOVER_RECHECK = 'GOOGLE_LEFTOVER_RECHECK';

/**
 * How long the search waits before its second look. That walk measured
 * IAM's list and get each trailing a delete by up to about 3 s.
 */
export const LEFTOVER_RECHECK_MS = 10_000;

export const systemLeftoverRecheck: LeftoverRecheckTimer = {
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};
