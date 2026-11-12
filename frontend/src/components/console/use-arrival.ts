import { useState } from "react";

/**
 * `animate-rise` for a settings card that was drawn as a `SectionPending`
 * skeleton first, and nothing otherwise.
 *
 * The motion says "this is what was loading": it bridges the skeleton to the
 * card that replaces it. A card whose read was already cached (a second visit
 * to the section) never showed a skeleton, so it has nothing to bridge and
 * must not rise — on a screen visited every day that would be decoration.
 *
 * Call it before the component's pending branch returns, with the same flag.
 */
export function useArrival(pending: boolean): string | undefined {
  const [waited] = useState(pending);
  return waited && !pending ? "animate-rise" : undefined;
}
