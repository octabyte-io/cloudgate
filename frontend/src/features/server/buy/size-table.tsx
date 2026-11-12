import { Chip } from "@/components/console/chip";
import type {
  CatalogueLocation,
  CatalogueSize,
  SizeFamily,
} from "@/lib/api/endpoints/bought-servers";
import { cn } from "@/lib/utils";

import { FAMILIES, offerIn, sizeLabel, wholeUsd } from "./buy-model";

/**
 * The sizes of one family in the chosen Location, each described by what it
 * is (layout A). A size sold there but sold out right now stays in the
 * table, greyed out, with "Unavailable in <city>", so the customer knows it
 * exists; one not sold there at all is left out. A native radio per row, so
 * the choice is one form control the keyboard already knows, and an
 * unavailable row's radio is disabled rather than hidden.
 */
export function SizeTable({
  sizes,
  family,
  location,
  chosen,
  onChoose,
}: {
  sizes: CatalogueSize[];
  family: SizeFamily;
  location: CatalogueLocation | null;
  chosen: string | null;
  onChoose: (sizeId: string) => void;
}) {
  const hint = FAMILIES.find((entry) => entry.value === family)?.hint;

  if (!location) {
    return (
      <p className="px-4 py-3.5 text-ui text-tx-3">
        Pick a location first. Prices and what can be bought depend on it.
      </p>
    );
  }

  const sold = sizes.filter(
    (size) => size.family === family && offerIn(size, location.id),
  );
  if (sold.length === 0) {
    const elsewhere = FAMILIES.filter((entry) =>
      sizes.some(
        (size) => size.family === entry.value && offerIn(size, location.id),
      ),
    ).map((entry) => entry.label);
    const label = FAMILIES.find((entry) => entry.value === family)?.label;
    const tryInstead =
      elsewhere.length > 0 ? ` Try ${elsewhere.join(" or ")}.` : "";
    return (
      <p className="px-4 py-3.5 text-ui text-tx-3">
        {`${label} isn’t offered in ${location.city}.${tryInstead}`}
      </p>
    );
  }

  // Keyed on the family, so switching Shared / Dedicated swaps the list with
  // a fade in place rather than a jump.
  return (
    <div key={family} className="animate-fade">
      {hint ? (
        <p className="px-4 pt-3 pb-2 text-meta text-tx-3">{hint}</p>
      ) : null}
      <table className="w-full border-collapse text-ui">
        <thead>
          <tr className="h-thead border-y border-line bg-panel-2 text-left text-tx-3">
            <th className="w-10 px-3 font-medium">
              <span className="sr-only">Choose</span>
            </th>
            <th className="px-3 font-medium">Size</th>
            <th className="px-3 text-right font-medium">Per month</th>
            <th className="px-3 font-medium">
              <span className="sr-only">Availability</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sold.map((size) => {
            const offer = offerIn(size, location.id)!;
            const off = !offer.available;
            const id = `size-${size.id}`;
            return (
              <tr
                key={size.id}
                data-unavailable={off || undefined}
                className={cn(
                  "h-row border-b border-line transition-colors duration-100 ease-out-strong last:border-b-0",
                  off
                    ? "hatch text-tx-3"
                    : chosen === size.id
                      ? "bg-brand-tint"
                      : "hover:bg-raise",
                )}
              >
                <td className="px-3">
                  <input
                    id={id}
                    type="radio"
                    name="size"
                    disabled={off}
                    checked={chosen === size.id}
                    onChange={() => onChoose(size.id)}
                    className="accent-brand"
                  />
                </td>
                <td className="px-3">
                  <label htmlFor={id} className={off ? "" : "cursor-pointer"}>
                    {sizeLabel(size)}
                  </label>
                </td>
                <td className="num px-3 text-right">
                  {wholeUsd(offer.monthly)}
                </td>
                <td className="px-3">
                  {off ? <Chip>Unavailable in {location.city}</Chip> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
