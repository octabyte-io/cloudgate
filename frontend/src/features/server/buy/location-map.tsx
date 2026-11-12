import type {
  CatalogueLocation,
  CatalogueSize,
} from "@/lib/api/endpoints/bought-servers";
import { cn } from "@/lib/utils";

import { offerIn, wholeUsd } from "./buy-model";
import type { Guess } from "./where-you-are";
import { LAND_PATH, WORLD, project } from "./world-land";

/** What a pin says under its city once a size is chosen. */
function pinPrice(
  size: CatalogueSize | null,
  locationId: string,
): { words: string; off: boolean } | null {
  if (!size) return null;
  const offer = offerIn(size, locationId);
  if (!offer) return { words: "Not offered", off: true };
  if (!offer.available) return { words: "Unavailable", off: true };
  return { words: `${wholeUsd(offer.monthly)}/mo`, off: false };
}

/**
 * The world map of every Location (layout A): a pin per Location, which
 * chooses it, and once a size is chosen, that size's price at each pin,
 * greyed out where it cannot be bought. "You" is drawn where the browser's
 * guess put the customer, and a dashed leg runs to the chosen Location.
 *
 * Each pin is a button for the keyboard and a screen reader as well as the
 * pointer: the cards below are the same choice, in a list.
 */
export function LocationMap({
  locations,
  me,
  approximate,
  chosen,
  size,
  onChoose,
}: {
  locations: CatalogueLocation[];
  me: Guess | null;
  approximate: boolean;
  chosen: string | null;
  size: CatalogueSize | null;
  onChoose: (locationId: string) => void;
}) {
  const chosenLocation = locations.find((entry) => entry.id === chosen);
  const mePoint = me ? project(me.latitude, me.longitude) : null;
  const chosenPoint = chosenLocation
    ? project(chosenLocation.latitude, chosenLocation.longitude)
    : null;

  return (
    <svg
      viewBox={`0 0 ${WORLD.width} ${WORLD.height}`}
      role="group"
      aria-label="World map of Server locations"
      className="block h-auto w-full rounded-md bg-sea"
    >
      <path d={LAND_PATH} className="fill-land" aria-hidden="true" />
      {mePoint && chosenPoint ? (
        <line
          x1={mePoint[0]}
          y1={mePoint[1]}
          x2={chosenPoint[0]}
          y2={chosenPoint[1]}
          className="nonscaling dash-grid fill-none stroke-tx-3 stroke-2"
          aria-hidden="true"
        />
      ) : null}
      {mePoint ? (
        // Ink, not a status hue: "you" is a place on the map, not a verdict,
        // and the brand is already the pins'.
        <g aria-hidden="true" className="fill-tx-2">
          <circle
            cx={mePoint[0]}
            cy={mePoint[1]}
            r={approximate ? 18 : 9}
            className="opacity-20"
          />
          <circle cx={mePoint[0]} cy={mePoint[1]} r={4.5} />
          <text
            x={mePoint[0] + 8}
            y={mePoint[1] + 16}
            className="stroke-sea stroke-3 text-meta font-semibold [paint-order:stroke]"
          >
            {approximate ? "You (about here)" : "You"}
          </text>
        </g>
      ) : null}
      {locations.map((location) => {
        const [x, y] = project(location.latitude, location.longitude);
        const on = location.id === chosen;
        const price = pinPrice(size, location.id);
        // West of its neighbour in a crowded region, a label goes left.
        const left = locations.some(
          (other) =>
            other.id !== location.id &&
            Math.abs(other.latitude - location.latitude) < 3 &&
            other.longitude > location.longitude &&
            other.longitude - location.longitude < 4,
        );
        const tx = left ? x - 11 : x + 11;
        const anchor = left ? "end" : "start";
        return (
          <g
            key={location.id}
            role="button"
            tabIndex={0}
            aria-pressed={on}
            aria-label={
              price ? `${location.city}, ${price.words}` : location.city
            }
            data-off={price?.off || undefined}
            className="cursor-pointer outline-none focus-visible:[&>.dot]:stroke-brand-ring"
            onClick={() => onChoose(location.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onChoose(location.id);
              }
            }}
          >
            <circle cx={x} cy={y} r={16} className="fill-transparent" />
            {on ? (
              <circle
                cx={x}
                cy={y}
                r={10}
                className="fill-none stroke-brand stroke-2"
              />
            ) : null}
            <circle
              cx={x}
              cy={y}
              r={6.5}
              className={cn(
                "dot stroke-panel stroke-2",
                price?.off ? "fill-tx-4" : "fill-brand",
              )}
            />
            <text
              x={tx}
              y={y + 4}
              textAnchor={anchor}
              className={cn(
                "stroke-sea stroke-3 text-ui [paint-order:stroke]",
                on ? "fill-tx font-semibold" : "fill-tx-2",
              )}
            >
              {location.city}
            </text>
            {price ? (
              <text
                x={tx}
                y={y + 19}
                textAnchor={anchor}
                className={cn(
                  "stroke-sea stroke-3 text-meta [paint-order:stroke]",
                  price.off ? "fill-tx-3" : "fill-brand-tx font-semibold",
                )}
              >
                {price.words}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}
