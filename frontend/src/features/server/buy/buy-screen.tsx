"use client";

import { notFound } from "next/navigation";
import { useMemo, useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { LinkButton } from "@/components/console/link-button";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import type { BoughtServerCatalogue } from "@/lib/api/endpoints/bought-servers";
import { errorMessage } from "@/lib/api/error-message";

import { BuyOptions } from "./buy-options";
import { BuySummary } from "./buy-summary";
import {
  ChosenDistance,
  LocationCards,
  WhereLine,
  type WhereYouAre,
} from "./location-cards";
import { LocationMap } from "./location-map";
import {
  useBoughtServerCatalogue,
  useBoughtServerOffer,
} from "./use-bought-servers";
import { useBuyForm } from "./use-buy-form";
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
  // Nothing is picked until the customer picks: the suggestions suggest.
  const form = useBuyForm(catalogue, null);
  const { location, size } = form;

  const ordered = useMemo(
    () => byDistance(catalogue.locations, where.guess),
    [catalogue.locations, where.guess],
  );

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

  const chosenEntry = ordered.find(
    (entry) => entry.location.id === location?.id,
  );

  return (
    <Cols
      aside={
        <BuySummary
          lines={form.lines}
          missing={form.missing}
          choice={form.choice}
        />
      }
      asideLabel="Summary"
      // Stretched, so the rail is as tall as the options and the summary's
      // own `cols:sticky` has room to stick: under `Cols`' `items-start` the
      // rail is only as tall as its card, and it scrolls away.
      className="items-stretch"
    >
      <BuyOptions
        catalogue={catalogue}
        ordered={ordered}
        form={form}
        locationSub="Pick a pin or a city."
        locationBody={
          <>
            <LocationMap
              locations={catalogue.locations}
              me={where.guess}
              approximate={where.how === "timezone"}
              chosen={location?.id ?? null}
              size={size}
              onChoose={form.chooseLocation}
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
              chosen={location?.id ?? null}
              onChoose={form.chooseLocation}
            />
          </>
        }
      />
    </Cols>
  );
}
