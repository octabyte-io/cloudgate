import type {
  BoughtServerCatalogue,
  CatalogueLocation,
  CatalogueSize,
  SizeFamily,
} from "@/lib/api/endpoints/bought-servers";
import { offerIn } from "@/features/server/buy/buy-model";
import { SUGGESTED_MEMORY_GB, suggestedLocation, suggestedSize } from "@/features/get-started/wizard-model";
import { distanceKm } from "@/features/server/buy/where-you-are";
import type { Position } from "@/features/server/buy/where-you-are";

/**
 * The decided Server family names (CONTEXT.md, **Server family**): what
 * `FAMILIES` in `buy-model.ts` becomes when this is built. The prototype
 * keeps its own copy so it changes nothing outside `/dev`.
 */
export const PROTO_FAMILIES: ReadonlyArray<{
  value: SizeFamily;
  label: string;
  hint: string;
}> = [
  {
    value: "shared",
    label: "Standard",
    hint: "Shared Intel or AMD cores, the cheapest. Good for most apps.",
  },
  {
    value: "amd",
    label: "Performance",
    hint: "Shared AMD cores, faster, and sold in every place.",
  },
  {
    value: "arm",
    label: "Arm",
    hint: "Shared Arm cores, the cheapest per core. The app must run on Arm.",
  },
  {
    value: "dedicated",
    label: "Dedicated",
    hint: "Cores reserved for this server alone, for steady heavy load.",
  },
];

/** A suggestion: a place and a size, and what it costs a month. */
export type Suggestion = {
  location: CatalogueLocation;
  size: CatalogueSize;
  monthly: number;
};

/**
 * **Closest and Cheapest** (CONTEXT.md): the nearest place where the app
 * fits, with the wizard's own suggested size there; and the place and size
 * anywhere that fits it for the least money, nearest first among equal
 * prices. Arm and Dedicated are left out of Cheapest: an image may not run
 * on Arm, and Dedicated is never the cheap answer.
 */
export function closestAndCheapest(
  ordered: Array<{ location: CatalogueLocation }>,
  catalogue: BoughtServerCatalogue,
  me: Position | null,
): { closest: Suggestion | null; cheapest: Suggestion | null } {
  const near = suggestedLocation(ordered, catalogue.sizes);
  const nearSize = near ? suggestedSize(catalogue.sizes, near.id) : undefined;
  const closest =
    near && nearSize
      ? { location: near, size: nearSize, monthly: offerIn(nearSize, near.id)!.monthly }
      : null;

  const candidates = catalogue.sizes
    .filter(
      (size) =>
        (size.family === "shared" || size.family === "amd") &&
        size.memoryGb >= SUGGESTED_MEMORY_GB,
    )
    .flatMap((size) =>
      size.offers
        .filter((offer) => offer.available)
        .map((offer) => ({
          location: catalogue.locations.find((at) => at.id === offer.locationId)!,
          size,
          monthly: offer.monthly,
        })),
    )
    .sort(
      (a, b) =>
        a.monthly - b.monthly ||
        (me ? distanceKm(me, a.location) - distanceKm(me, b.location) : 0),
    );
  return { closest, cheapest: candidates[0] ?? null };
}
