import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import type {
  CatalogueLocation,
  CatalogueSize,
} from "@/lib/api/endpoints/bought-servers";
import { cn } from "@/lib/utils";

import {
  SUGGESTED_MEMORY_GB,
  countryName,
  shortSizeLabel,
  wholeUsd,
} from "./buy-model";
import {
  closestAndCheapest,
  sameSuggestion,
  type Suggestion,
} from "./suggestions";

/**
 * The Buy screen's first card: Closest and Cheapest for a size with
 * {@link SUGGESTED_MEMORY_GB}, worked out from the places nearest first.
 * Absent when nothing fits anywhere.
 */
export function Suggested({
  ordered,
  sizes,
  chosen,
  onChoose,
}: {
  ordered: ReadonlyArray<{ location: CatalogueLocation }>;
  sizes: readonly CatalogueSize[];
  chosen: { locationId: string | null; sizeId: string | null };
  onChoose: (suggestion: Suggestion) => void;
}) {
  const { closest, cheapest } = closestAndCheapest(
    ordered,
    sizes,
    SUGGESTED_MEMORY_GB,
  );
  if (!closest && !cheapest) return null;
  return (
    <Card>
      <Card.Header
        title="Suggested"
        sub="Near you, or the least it can cost. Or pick a place and a size yourself below."
        headingLevel={2}
      />
      <Card.Body>
        <SuggestionCards
          closest={closest}
          cheapest={cheapest}
          chosen={chosen}
          onChoose={onChoose}
        />
      </Card.Body>
    </Card>
  );
}

/**
 * **Closest and Cheapest** (CONTEXT.md) as two cards at the top of the Buy
 * form: each names its place, its size and its monthly price, and picking
 * one sets the place and the size below, where every other choice stays.
 * When both are the same Server, one card carries both chips.
 *
 * Nothing is picked until the customer picks: the cards suggest, the form
 * below decides.
 */
export function SuggestionCards({
  closest,
  cheapest,
  chosen,
  onChoose,
}: {
  closest: Suggestion | null;
  cheapest: Suggestion | null;
  chosen: { locationId: string | null; sizeId: string | null };
  onChoose: (suggestion: Suggestion) => void;
}) {
  const cards: Array<{ suggestion: Suggestion; chips: string[] }> = [];
  if (closest && cheapest && sameSuggestion(closest, cheapest)) {
    cards.push({ suggestion: closest, chips: ["Closest", "Cheapest"] });
  } else {
    if (closest) cards.push({ suggestion: closest, chips: ["Closest"] });
    if (cheapest) cards.push({ suggestion: cheapest, chips: ["Cheapest"] });
  }
  if (cards.length === 0) return null;

  return (
    <ul aria-label="Suggested Servers" className="grid gap-2 sm:grid-cols-2">
      {cards.map(({ suggestion, chips }) => {
        const { location, size, monthly } = suggestion;
        const on =
          chosen.locationId === location.id && chosen.sizeId === size.id;
        return (
          <li key={chips.join("-")}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onChoose(suggestion)}
              className={cn(
                "grid w-full min-w-0 gap-1 rounded-md border px-3 py-2.5 text-left transition-colors duration-100 ease-out-strong",
                on
                  ? "border-brand bg-brand-tint ring-1 ring-brand"
                  : "border-line-2 bg-panel hover:bg-raise",
              )}
            >
              <span className="flex flex-wrap items-center gap-1.5">
                {/* Plain chips: "closest" and "cheapest" are facts about
                    distance and price, not statuses. */}
                {chips.map((chip) => (
                  <Chip key={chip}>{chip}</Chip>
                ))}
              </span>
              <span className="flex items-baseline justify-between gap-2 text-body font-medium text-tx">
                <span className="min-w-0 truncate">
                  {location.city}, {countryName(location.country)}
                </span>
                <span className="tabular-nums">
                  {wholeUsd(monthly)}
                  <span className="text-meta font-normal text-tx-3">
                    {" "}
                    a month
                  </span>
                </span>
              </span>
              <span className="text-meta text-tx-3">
                {shortSizeLabel(size)}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
