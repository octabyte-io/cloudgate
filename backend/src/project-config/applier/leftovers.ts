import type { PlanStepLeftovers } from './apply.types';

/**
 * A Delete's leftovers, each field absent rather than empty, on the Delete's
 * own rule; `null` when it left nothing. A database's data volume is one
 * only when it was kept or its fate is unknown (`true` or `null`), never
 * when the Delete removed it (`false`). A bucket a Delete kept is one.
 * Every Delete answer is read here: a plan's destroy step's and a
 * console Delete's save plan's.
 */
export function leftoversOf(found: {
  unreclaimedArtifacts?: PlanStepLeftovers['unreclaimedArtifacts'];
  unreclaimedImages?: PlanStepLeftovers['unreclaimedImages'];
  orphanedPreviews?: PlanStepLeftovers['orphanedPreviews'];
  volumeLeftBehind?: boolean | null;
  bucketLeftBehind?: PlanStepLeftovers['bucketLeftBehind'];
  bucketLeftAsItWas?: PlanStepLeftovers['bucketLeftAsItWas'];
}): PlanStepLeftovers | null {
  const kept: {
    -readonly [K in keyof PlanStepLeftovers]: PlanStepLeftovers[K];
  } = {};
  if (found.unreclaimedArtifacts?.length) {
    kept.unreclaimedArtifacts = found.unreclaimedArtifacts;
  }
  if (found.unreclaimedImages?.length) {
    kept.unreclaimedImages = found.unreclaimedImages;
  }
  if (found.orphanedPreviews?.length) {
    kept.orphanedPreviews = found.orphanedPreviews;
  }
  if (
    found.volumeLeftBehind !== undefined &&
    found.volumeLeftBehind !== false
  ) {
    kept.volumeLeftBehind = found.volumeLeftBehind;
  }
  if (found.bucketLeftBehind) kept.bucketLeftBehind = found.bucketLeftBehind;
  if (found.bucketLeftAsItWas) {
    kept.bucketLeftAsItWas = found.bucketLeftAsItWas;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}
