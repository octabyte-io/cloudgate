import { useState } from "react";

import type {
  BoughtServerCatalogue,
  BuyChoice,
  SizeFamily,
} from "@/lib/api/endpoints/bought-servers";

import type { SummaryLine } from "./buy-summary";
import {
  FAMILIES,
  chosenImage,
  imagesFor,
  offerIn,
  shortSizeLabel,
  storageMonthly,
} from "./buy-model";
import type { Suggestion } from "./suggestions";

/**
 * What one Buy holds, for both forms that buy a Server (the Buy screen and
 * the get-started wizard's step 1): the Location, the family and size, the
 * Server image and the extras, and what the summary makes of them (its
 * lines, what is still missing, and the choice Buy sends).
 *
 * `start` is the suggestion the form opens on, or null to open with nothing
 * picked.
 */
export function useBuyForm(
  catalogue: BoughtServerCatalogue,
  start: Suggestion | null,
) {
  const [locationId, setLocationId] = useState<string | null>(
    start?.location.id ?? null,
  );
  const [family, setFamily] = useState<SizeFamily>(
    () =>
      start?.size.family ??
      FAMILIES.find((entry) =>
        catalogue.sizes.some((size) => size.family === entry.value),
      )?.value ??
      "shared",
  );
  const [sizeId, setSizeId] = useState<string | null>(start?.size.id ?? null);
  const [imageId, setImageId] = useState<string | null>(null);
  const [backups, setBackups] = useState(false);
  const [storageGb, setStorageGb] = useState<number | null>(null);

  const location =
    catalogue.locations.find((entry) => entry.id === locationId) ?? null;
  const size = catalogue.sizes.find((entry) => entry.id === sizeId) ?? null;
  const offer = size && location ? offerIn(size, location.id) : undefined;
  // The image picked stays picked while the size can run it; a size of
  // another architecture falls back to the default.
  const image = chosenImage(catalogue, size, imageId);

  function chooseLocation(next: string) {
    setLocationId(next);
    // A size that cannot be bought in the new Location is let go of.
    const kept = size ? offerIn(size, next) : undefined;
    if (!kept?.available) setSizeId(null);
  }

  function chooseSuggestion({ location: next, size: picked }: Suggestion) {
    setLocationId(next.id);
    setFamily(picked.family);
    setSizeId(picked.id);
  }

  const lines: SummaryLine[] = [];
  if (size && location && offer) {
    lines.push({
      label: `Server, ${shortSizeLabel(size)}, ${location.city}${image ? `, ${image.label}` : ""}`,
      monthly: offer.monthly,
    });
    if (backups)
      lines.push({ label: "Backups", monthly: offer.backupsMonthly });
  }
  const storageOk =
    storageGb !== null &&
    Number.isInteger(storageGb) &&
    storageGb >= catalogue.storage.minGb &&
    storageGb <= catalogue.storage.maxGb;
  if (lines.length > 0 && storageOk) {
    lines.push({
      label: `Extra storage, ${storageGb} GB`,
      monthly: storageMonthly(storageGb, catalogue.storage.perGbMonthly),
    });
  }

  const missing = !location
    ? "Pick a location."
    : !offer
      ? "Pick a size."
      : !image
        ? "Pick an operating system."
        : storageGb !== null && !storageOk
          ? `Extra storage is a whole number of GB from ${catalogue.storage.minGb} to ${catalogue.storage.maxGb.toLocaleString("en-US")}. Leave it empty for none.`
          : null;

  const choice: BuyChoice | null =
    size && location && offer?.available && image
      ? {
          serverType: size.id,
          location: location.id,
          image: image.id,
          backups,
          ...(storageOk ? { storageGb } : {}),
        }
      : null;

  return {
    location,
    chooseLocation,
    family,
    setFamily,
    size,
    setSizeId,
    offer,
    images: imagesFor(catalogue, size),
    image,
    setImageId,
    backups,
    setBackups,
    storageGb,
    setStorageGb,
    chooseSuggestion,
    lines,
    missing,
    choice,
  };
}

export type BuyForm = ReturnType<typeof useBuyForm>;
