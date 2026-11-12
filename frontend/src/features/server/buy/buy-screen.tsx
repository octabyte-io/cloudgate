"use client";

import { notFound } from "next/navigation";
import { useMemo, useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { LinkButton } from "@/components/console/link-button";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Segmented } from "@/components/console/segmented";
import { Skeleton } from "@/components/console/skeleton";
import type {
  BoughtServerCatalogue,
  SizeFamily,
} from "@/lib/api/endpoints/bought-servers";
import { errorMessage } from "@/lib/api/error-message";

import { BuySummary, type SummaryLine } from "./buy-summary";
import { FAMILIES, offerIn, shortSizeLabel, storageMonthly } from "./buy-model";
import { ExtrasCard } from "./extras-card";
import {
  ChosenDistance,
  LocationCards,
  WhereLine,
  type WhereYouAre,
} from "./location-cards";
import { LocationMap } from "./location-map";
import { SizeTable } from "./size-table";
import {
  useBoughtServerCatalogue,
  useBoughtServerOffer,
} from "./use-bought-servers";
import {
  browserTimeZone,
  byDistance,
  guessFromTimeZone,
} from "./where-you-are";

/**
 * *Buy a Server* (ADR-0071), layout A of #1384's prototype: the map and the
 * Location cards, the size table, the extras, and a summary that stays in
 * view. Hosted only, and only while buying is offered: anywhere else the
 * page does not exist, so it answers the console's not-found.
 *
 * Buy charges at once and sends the customer back to Servers, where the
 * purchase waits for payment or is being made (#1389).
 */
export function BuyScreen() {
  const offer = useBoughtServerOffer();
  const catalogue = useBoughtServerCatalogue(offer.offered);

  if (!offer.pending && !offer.offered) notFound();

  return (
    <Page>
      <PageHeader
        title="Buy a Server"
        icon="hdd"
        lede="Pick where it runs and how big it is, and Cloudgate sets it up for you."
        actions={<LinkButton href="/servers">Back to Servers</LinkButton>}
      />
      {catalogue.error ? (
        <Card>
          <Card.Body>
            <p className="text-body text-tx-2">
              {errorMessage(catalogue.error)}
            </p>
          </Card.Body>
        </Card>
      ) : catalogue.data ? (
        <Chooser catalogue={catalogue.data} />
      ) : (
        <div className="grid gap-4" aria-busy="true">
          <Skeleton className="h-plot" />
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
        </div>
      )}
    </Page>
  );
}

/** The choices and what they cost, once the catalogue is in. */
function Chooser({ catalogue }: { catalogue: BoughtServerCatalogue }) {
  // From the time zone, worked out here and never sent; replaced only by
  // the browser's own answer after Show where I am.
  const [where, setWhere] = useState<WhereYouAre>(() => ({
    guess: guessFromTimeZone(browserTimeZone()),
    how: "timezone",
    refused: null,
  }));
  const [locationId, setLocationId] = useState<string | null>(null);
  const [family, setFamily] = useState<SizeFamily>(
    () =>
      FAMILIES.find((entry) =>
        catalogue.sizes.some((size) => size.family === entry.value),
      )?.value ?? "shared",
  );
  const [sizeId, setSizeId] = useState<string | null>(null);
  const [backups, setBackups] = useState(false);
  const [storageGb, setStorageGb] = useState<number | null>(null);

  const ordered = useMemo(
    () => byDistance(catalogue.locations, where.guess),
    [catalogue.locations, where.guess],
  );
  const location =
    catalogue.locations.find((entry) => entry.id === locationId) ?? null;
  const size = catalogue.sizes.find((entry) => entry.id === sizeId) ?? null;
  const offer = size && location ? offerIn(size, location.id) : undefined;

  function chooseLocation(next: string) {
    setLocationId(next);
    // A size that cannot be bought in the new Location is let go of.
    const kept = size ? offerIn(size, next) : undefined;
    if (!kept?.available) setSizeId(null);
  }

  function askBrowser() {
    if (!("geolocation" in navigator)) {
      setWhere((now) => ({ ...now, refused: "Your browser can't say." }));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (position) =>
        setWhere({
          guess: {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            near: null,
          },
          how: "browser",
          refused: null,
        }),
      () =>
        setWhere((now) => ({
          ...now,
          refused: "Your browser didn't share a location.",
        })),
    );
  }

  const lines: SummaryLine[] = [];
  if (size && location && offer) {
    lines.push({
      label: `Server, ${shortSizeLabel(size)}, ${location.city}`,
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

  const chosenEntry = ordered.find((entry) => entry.location.id === locationId);

  return (
    <Cols
      aside={
        <BuySummary
          lines={lines}
          missing={
            !location
              ? "Pick a location."
              : !offer
                ? "Pick a size."
                : storageGb !== null && !storageOk
                  ? `Extra storage is a whole number of GB from ${catalogue.storage.minGb} to ${catalogue.storage.maxGb.toLocaleString("en-US")}. Leave it empty for none.`
                  : null
          }
          choice={
            size && location && offer?.available
              ? {
                  serverType: size.id,
                  location: location.id,
                  backups,
                  ...(storageOk ? { storageGb } : {}),
                }
              : null
          }
        />
      }
      asideLabel="Summary"
    >
      <Card>
        <Card.Header
          title="1. Location"
          sub="Pick a pin or a city."
          headingLevel={2}
        />
        <Card.Body className="grid gap-3">
          <LocationMap
            locations={catalogue.locations}
            me={where.guess}
            approximate={where.how === "timezone"}
            chosen={locationId}
            size={size}
            onChoose={chooseLocation}
          />
          <WhereLine where={where} onAsk={askBrowser} />
          {location && chosenEntry ? (
            <ChosenDistance
              location={location}
              distance={chosenEntry.km}
              closest={ordered[0]?.location.id === location.id}
            />
          ) : null}
          <LocationCards
            ordered={ordered}
            chosen={locationId}
            onChoose={chooseLocation}
          />
        </Card.Body>
      </Card>

      <Card>
        <Card.Header
          title={location ? `2. Size in ${location.city}` : "2. Size"}
          headingLevel={2}
          actions={
            <Segmented
              label="Kind of Server"
              options={FAMILIES.map(({ value, label }) => ({ value, label }))}
              value={family}
              onChange={setFamily}
            />
          }
        />
        <Card.Body flush>
          <SizeTable
            sizes={catalogue.sizes}
            family={family}
            location={location}
            chosen={sizeId}
            onChoose={setSizeId}
          />
        </Card.Body>
      </Card>

      <ExtrasCard
        backups={backups}
        onBackups={setBackups}
        backupsMonthly={offer?.backupsMonthly ?? null}
        storageGb={storageGb}
        onStorageGb={setStorageGb}
        storage={catalogue.storage}
      />
    </Cols>
  );
}
