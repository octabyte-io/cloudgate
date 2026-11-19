import { useState } from "react";

import type {
  BoughtServerCatalogue,
  CatalogueLocation,
} from "@/lib/api/endpoints/bought-servers";

import {
  ChosenDistance,
  LocationCards,
  WhereLine,
  type WhereYouAre,
} from "./location-cards";
import { LocationMap } from "./location-map";
import type { BuyForm } from "./use-buy-form";
import { browserTimeZone, guessFromTimeZone } from "./where-you-are";

/**
 * Where the buyer is: guessed from the time zone, worked out here and never
 * sent, and replaced only by the browser's own answer after *Show where I am*,
 * which is asked only when pressed. Its owner orders the locations by it, so
 * it lives with whoever renders {@link BuyOptions}, not in the Location card.
 */
export function useWhereYouAre(): {
  where: WhereYouAre;
  askBrowser: () => void;
} {
  const [where, setWhere] = useState<WhereYouAre>(() => ({
    guess: guessFromTimeZone(browserTimeZone()),
    how: "timezone",
    refused: null,
  }));

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

  return { where, askBrowser };
}

/**
 * The 1. Location card's body, on both buy forms (#127): the map with a pin
 * per location, where the buyer is and the way to ask the browser, how far
 * the chosen city is, and the city cards. One component, so the Buy screen's
 * and Get started's Location cards cannot drift apart again.
 */
export function LocationChooser({
  catalogue,
  ordered,
  form,
  where,
  onAsk,
}: {
  catalogue: BoughtServerCatalogue;
  ordered: Array<{ location: CatalogueLocation; km: number | null }>;
  form: BuyForm;
  where: WhereYouAre;
  onAsk: () => void;
}) {
  const { location, size } = form;
  const chosenEntry = ordered.find(
    (entry) => entry.location.id === location?.id,
  );
  return (
    <>
      <LocationMap
        locations={catalogue.locations}
        me={where.guess}
        approximate={where.how === "timezone"}
        chosen={location?.id ?? null}
        size={size}
        onChoose={form.chooseLocation}
      />
      <WhereLine where={where} onAsk={onAsk} />
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
  );
}
