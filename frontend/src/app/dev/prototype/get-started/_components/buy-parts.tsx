"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { Field } from "@/components/console/field";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Picker } from "@/components/console/picker";
import { Segmented } from "@/components/console/segmented";
import type {
  BuyChoice,
  CatalogueLocation,
  SizeFamily,
} from "@/lib/api/endpoints/bought-servers";
import { keys } from "@/lib/api/keys";
import {
  countryName,
  offerIn,
  shortSizeLabel,
  storageMonthly,
  wholeUsd,
} from "@/features/server/buy/buy-model";
import type { SummaryLine } from "@/features/server/buy/buy-summary";
import { SizeTable } from "@/features/server/buy/size-table";
import { byDistance } from "@/features/server/buy/where-you-are";

import {
  CATALOGUE,
  CUSTOMER,
  DEFAULT_IMAGE,
  IMAGES,
  todayFor,
} from "./fixtures";
import { PROTO_FAMILIES, closestAndCheapest } from "./proto-model";
import type { Suggestion } from "./proto-model";

/**
 * Everything one Buy holds, for every variant: the place, size, image and
 * extras, the two suggestions, and the summary's lines. The Today box reads
 * `useBoughtServerToday`, which is off signed out (no Organization), so the
 * answer it would get is seeded under its real key and the real summary
 * shows it as it would.
 */
export function useBuyChoice() {
  const ordered = useMemo(() => byDistance(CATALOGUE.locations, CUSTOMER), []);
  const { closest, cheapest } = useMemo(
    () => closestAndCheapest(ordered, CATALOGUE, CUSTOMER),
    [ordered],
  );
  const [locationId, setLocationId] = useState(closest?.location.id ?? "fsn1");
  const [sizeId, setSizeId] = useState(closest?.size.id ?? null);
  const [family, setFamily] = useState<SizeFamily>(closest?.size.family ?? "shared");
  const [image, setImage] = useState(DEFAULT_IMAGE);
  const [backups, setBackups] = useState(false);
  const [storageGb, setStorageGb] = useState<number | null>(null);

  const location = CATALOGUE.locations.find((at) => at.id === locationId)!;
  const size = CATALOGUE.sizes.find((entry) => entry.id === sizeId) ?? null;
  const offer = size ? offerIn(size, locationId) : undefined;
  const storageOk =
    storageGb === null ||
    (storageGb >= CATALOGUE.storage.minGb && storageGb <= CATALOGUE.storage.maxGb);

  const lines: SummaryLine[] =
    size && offer?.available
      ? [
          { label: `${shortSizeLabel(size)} in ${location.city}`, monthly: offer.monthly },
          ...(backups ? [{ label: "Backups", monthly: offer.backupsMonthly }] : []),
          ...(storageGb !== null && storageOk
            ? [
                {
                  label: `${storageGb} GB extra storage`,
                  monthly: storageMonthly(storageGb, CATALOGUE.storage.perGbMonthly),
                },
              ]
            : []),
        ]
      : [];
  const missing = !size || !offer?.available
    ? `Pick a size that can be bought in ${location.city}.`
    : storageOk
      ? null
      : "Fix the extra storage size.";
  const choice: BuyChoice | null =
    missing === null && size
      ? {
          serverType: size.id,
          location: locationId,
          backups,
          ...(storageGb !== null ? { storageGb } : {}),
        }
      : null;

  const client = useQueryClient();
  const total = lines.reduce((sum, line) => sum + line.monthly, 0);
  const serverType = choice?.serverType ?? null;
  useEffect(() => {
    if (serverType === null) return;
    client.setQueryData(
      keys.boughtServers.today(
        null,
        serverType,
        locationId,
        backups,
        storageGb ?? null,
      ),
      todayFor(total),
    );
  }, [client, serverType, locationId, backups, storageGb, total]);

  function choosePlace(next: string) {
    setLocationId(next);
    const kept = size ? offerIn(size, next) : undefined;
    if (!kept?.available) setSizeId(null);
  }

  function pick(suggestion: Suggestion) {
    setLocationId(suggestion.location.id);
    setSizeId(suggestion.size.id);
    setFamily(suggestion.size.family);
  }

  const picked = (suggestion: Suggestion | null) =>
    suggestion !== null &&
    suggestion.location.id === locationId &&
    suggestion.size.id === sizeId;

  return {
    ordered,
    closest,
    cheapest,
    picked,
    pick,
    location,
    choosePlace,
    size,
    offer,
    sizeId,
    setSizeId,
    family,
    setFamily,
    image,
    setImage,
    backups,
    setBackups,
    storageGb,
    setStorageGb,
    lines,
    missing,
    choice,
  };
}

export type BuyState = ReturnType<typeof useBuyChoice>;

/** The two suggestions as cards; picking one sets the place and the size. */
export function SuggestionPicks({ buy }: { buy: BuyState }) {
  const cards = [
    { word: "Closest", suggestion: buy.closest },
    { word: "Cheapest", suggestion: buy.cheapest },
  ].filter(
    (entry): entry is { word: string; suggestion: Suggestion } =>
      entry.suggestion !== null,
  );
  return (
    <PickGrid label="Suggested servers">
      {cards.map(({ word, suggestion }) => (
        <PickCard
          key={word}
          title={word}
          selected={buy.picked(suggestion)}
          onClick={() => buy.pick(suggestion)}
          description={`${placeName(suggestion.location)} · ${shortSizeLabel(suggestion.size)}`}
          meta={`${wholeUsd(suggestion.monthly)} a month`}
        />
      ))}
    </PickGrid>
  );
}

/** The four Server families, the chosen one's hint, and its sizes in the chosen place. */
export function FamilySizes({ buy }: { buy: BuyState }) {
  const hint = PROTO_FAMILIES.find((entry) => entry.value === buy.family)?.hint;
  return (
    <div className="grid gap-2">
      <div className="grid justify-items-start gap-1.5">
        <Segmented
          label="Server family"
          options={PROTO_FAMILIES.map(({ value, label }) => ({ value, label }))}
          value={buy.family}
          onChange={buy.setFamily}
        />
        <p className="text-meta text-tx-3">{hint}</p>
      </div>
      {/* SizeTable prints today's family hint above its rows; the
          prototype's own, with the decided names, replaces it. */}
      <div className="overflow-x-auto rounded-lg border border-line [&>div>p:first-child]:hidden">
        <SizeTable
          sizes={CATALOGUE.sizes}
          family={buy.family}
          location={buy.location as CatalogueLocation}
          chosen={buy.sizeId}
          onChoose={buy.setSizeId}
        />
      </div>
    </div>
  );
}

/** The Server image: Ubuntu or Debian, any version offered now. */
export function ImageField({ buy }: { buy: BuyState }) {
  return (
    <Field
      name="image"
      label="Image"
      hint="Cloudgate sets up Ubuntu and Debian servers."
      manual
      className="max-w-md"
    >
      <Picker
        value={buy.image}
        onValueChange={buy.setImage}
        options={IMAGES.map((image) => ({
          value: image.id,
          label: image.label,
          detail: image.detail,
        }))}
      />
    </Field>
  );
}

/** `Helsinki, Finland`; a city-state once: `Singapore`. */
export function placeName(location: CatalogueLocation): string {
  const country = countryName(location.country);
  return country === location.city ? location.city : `${location.city}, ${country}`;
}

/** `Ubuntu 24.04`, for a one-line summary. */
export function imageLabel(id: string): string {
  return IMAGES.find((image) => image.id === id)?.label ?? id;
}
