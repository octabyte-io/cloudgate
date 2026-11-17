import type {
  CatalogueLocation,
  CatalogueSize,
} from "@/lib/api/endpoints/bought-servers";

import { offerIn } from "./buy-model";

/** One suggested Server: where, which size, and its monthly price there. */
export type Suggestion = {
  location: CatalogueLocation;
  size: CatalogueSize;
  monthly: number;
};

/**
 * **Closest and Cheapest** (CONTEXT.md): the two Servers the Buy form opens
 * with. A size fits when it can be bought there now, has at least
 * `minMemoryGb`, and is not Arm, which runs only images built for Arm and so
 * is never suggested for an app nobody has checked.
 *
 * - **Closest**: in the nearest place where something fits, the cheapest
 *   size that fits.
 * - **Cheapest**: the lowest monthly price that fits, anywhere; a tie goes to
 *   the nearer place.
 *
 * `ordered` is nearest first, as `byDistance` answers. When both are the same
 * place and size, the caller shows one card that says both.
 */
export function closestAndCheapest(
  ordered: ReadonlyArray<{ location: CatalogueLocation }>,
  sizes: readonly CatalogueSize[],
  minMemoryGb: number,
): { closest: Suggestion | null; cheapest: Suggestion | null } {
  const fitsIn = (location: CatalogueLocation): Suggestion[] =>
    sizes
      .filter((size) => size.family !== "arm" && size.memoryGb >= minMemoryGb)
      .flatMap((size) => {
        const offer = offerIn(size, location.id);
        return offer?.available
          ? [{ location, size, monthly: offer.monthly }]
          : [];
      })
      .sort((a, b) => a.monthly - b.monthly);

  let closest: Suggestion | null = null;
  let cheapest: Suggestion | null = null;
  for (const { location } of ordered) {
    const best = fitsIn(location)[0];
    if (!best) continue;
    closest ??= best;
    if (!cheapest || best.monthly < cheapest.monthly) cheapest = best;
  }
  return { closest, cheapest };
}

/** Whether two suggestions are the same Server, shown then as one card. */
export function sameSuggestion(a: Suggestion, b: Suggestion): boolean {
  return a.location.id === b.location.id && a.size.id === b.size.id;
}
