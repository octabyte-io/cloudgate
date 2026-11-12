import { Chip } from "@/components/console/chip";
import { Button } from "@/components/ui/button";
import type { CatalogueLocation } from "@/lib/api/endpoints/bought-servers";
import { cn } from "@/lib/utils";

import { countryName } from "./buy-model";
import { roughKm } from "./where-you-are";
import type { Guess } from "./where-you-are";

/** Where the page thinks the customer is, and how it came to think so. */
export type WhereYouAre = {
  guess: Guess | null;
  /** `timezone` until *Show where I am* is pressed and answered. */
  how: "timezone" | "browser";
  /** Why the browser gave no position, once it was asked and did not. */
  refused: string | null;
};

function km(value: number): string {
  return `about ${roughKm(value).toLocaleString("en-US")} km`;
}

/**
 * The line under the map: where the customer is taken to be, and *Show where
 * I am*, which asks the browser only when pressed. Nothing it learns leaves
 * the page.
 */
export function WhereLine({
  where,
  onAsk,
}: {
  where: WhereYouAre;
  onAsk: () => void;
}) {
  const { guess, how, refused } = where;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 text-ui">
      <p className="text-tx-2">
        {guess ? (
          <>
            <span className="font-medium text-tx">You:</span>{" "}
            {guess.near ? `near ${guess.near}` : "position guessed"}
            <span className="text-tx-3">
              {" "}
              ·{" "}
              {how === "browser" ? "from your browser" : "from your time zone"}
            </span>
          </>
        ) : (
          "We don't know where you are."
        )}
      </p>
      {how === "timezone" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onAsk}>
            Show where I am
          </Button>
          <span className="text-meta text-tx-3">
            {refused ??
              "Your browser asks first. Your position stays on this page."}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every Location as a card, nearest first, with **Closest** on the nearest
 * (layout A). The same choice as the map's pins, as a list a keyboard and a
 * screen reader can walk.
 */
export function LocationCards({
  ordered,
  chosen,
  onChoose,
}: {
  ordered: Array<{ location: CatalogueLocation; km: number | null }>;
  chosen: string | null;
  onChoose: (locationId: string) => void;
}) {
  const closest = ordered[0]?.km !== null ? ordered[0]?.location.id : null;
  return (
    <ul
      aria-label="Locations, nearest first"
      className="grid grid-cols-[repeat(auto-fill,minmax(var(--spacing-pick),1fr))] gap-2"
    >
      {ordered.map(({ location, km: distance }) => {
        const on = location.id === chosen;
        return (
          <li key={location.id}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onChoose(location.id)}
              className={cn(
                "grid w-full min-w-0 gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors duration-100 ease-out-strong",
                on
                  ? "border-brand bg-brand-tint ring-1 ring-brand"
                  : "border-line-2 bg-panel hover:bg-raise",
              )}
            >
              <span className="flex items-center justify-between gap-1.5 text-body font-medium text-tx">
                <span className="min-w-0 truncate">{location.city}</span>
                {/* A plain chip: "closest" is a fact about distance, not a
                    status, so it takes no status hue. */}
                {location.id === closest ? <Chip>Closest</Chip> : null}
              </span>
              <span className="text-meta text-tx-3">
                {countryName(location.country)}
                {distance !== null ? ` · ${km(distance)}` : ""}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** How far the chosen Location is, and whether it is the closest. */
export function ChosenDistance({
  location,
  distance,
  closest,
}: {
  location: CatalogueLocation;
  distance: number | null;
  closest: boolean;
}) {
  if (distance === null) return null;
  return (
    <p className="text-ui text-tx-2">
      {location.city} is{" "}
      <span className="font-medium text-tx">{km(distance)}</span> from you.
      {closest ? " It is the closest." : null}
    </p>
  );
}
