import type {
  CatalogueOffer,
  CatalogueSize,
  SizeFamily,
} from "@/lib/api/endpoints/bought-servers";

/**
 * The words and sums *Buy a Server* shows (ADR-0071). A size is described by
 * what it is and grouped by family, **never by the provider's code**: the
 * catalogue's ids name sizes and Locations for a purchase, and nothing here
 * renders one.
 */

export const FAMILIES: ReadonlyArray<{
  value: SizeFamily;
  label: string;
  hint: string;
}> = [
  { value: "shared", label: "Shared", hint: "Good value for most apps." },
  {
    value: "arm",
    label: "Shared Arm",
    hint: "Cheaper per core. Your images must run on Arm.",
  },
  {
    value: "amd",
    label: "Shared AMD",
    hint: "Faster shared cores, in more locations.",
  },
  {
    value: "dedicated",
    label: "Dedicated",
    hint: "Cores that are yours alone, for steady heavy load.",
  },
];

/** `3 vCPU · 4 GB RAM · 80 GB disk`. */
export function sizeLabel(
  size: Pick<CatalogueSize, "vcpus" | "memoryGb" | "diskGb">,
): string {
  return `${size.vcpus} vCPU · ${size.memoryGb} GB RAM · ${size.diskGb} GB disk`;
}

/** `3 vCPU · 4 GB`, for a summary line. */
export function shortSizeLabel(size: CatalogueSize): string {
  return `${size.vcpus} vCPU · ${size.memoryGb} GB`;
}

/** A country's English name from its ISO code, or the code when the browser has no name for it. */
export function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** The size's offer in one Location, or undefined where it is not sold at all. */
export function offerIn(
  size: CatalogueSize,
  locationId: string,
): CatalogueOffer | undefined {
  return size.offers.find((offer) => offer.locationId === locationId);
}

/** Whole dollars, as the page writes every price: `$29`, `$1,210`. */
export function wholeUsd(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

/**
 * The backend's rounding (`bought-servers/pricing.ts`), for the one price
 * the page works out itself: extra storage at any size the customer types.
 * The catalogue sends the marked-up price of one GB rather than a price per
 * possible size; the purchase prices it again on the backend, so this only
 * has to agree, and works in millionths of a dollar for the same reason.
 */
export function tidyUsd(amount: number): number {
  const micros = Math.round(amount * 1_000_000);
  const dollars = Math.ceil(micros / 1_000_000);
  return dollars <= 100 ? dollars : Math.ceil(micros / 5_000_000) * 5;
}

/** Extra storage's monthly price at `sizeGb`. */
export function storageMonthly(sizeGb: number, perGbMonthly: number): number {
  return tidyUsd(sizeGb * perGbMonthly);
}
