/**
 * How a **Bought Server**'s prices are made from the provider's USD list
 * (ADR-0071): pure, so the catalogue, a purchase and an Operator's reprice
 * all price the same way.
 *
 * A price is the list price (plus the Primary IPv4's for a Server), times
 * one plus the **Server markup**, rounded **up** to a whole dollar, or to a
 * multiple of 5 dollars above 100, so it looks deliberate. Backups and extra
 * storage are priced the same way from their own list prices. Every price
 * this module answers is whole US dollars.
 */

/** The Server markup until an Operator sets one (ADR-0071). */
export const DEFAULT_SERVER_MARKUP_PERCENT = 20;

/**
 * Money is worked in millionths of a dollar. Cents would round a list price
 * of 5.004 down to 5.00 and lose the dollar "rounded up" owes; floating
 * dollars put `(0.1 + 0.2) * 10` a hair over 3 and charge a fourth. A
 * millionth keeps the provider's four-decimal per-GB prices exact and rounds
 * the noise away.
 */
const MICROS = 1_000_000;

function microsOf(usd: number): number {
  return Math.round(usd * MICROS);
}

function marked(micros: number, markupPercent: number): number {
  return Math.round((micros * (100 + markupPercent)) / 100);
}

function tidyMicros(micros: number): number {
  const dollars = Math.ceil(micros / MICROS);
  return dollars <= 100 ? dollars : Math.ceil(micros / (5 * MICROS)) * 5;
}

/**
 * An amount, rounded up to a whole dollar at or under 100, and up to a
 * multiple of 5 dollars above it.
 */
export function tidyUsd(usd: number): number {
  return tidyMicros(microsOf(usd));
}

/** A Server's monthly price: its size's list price there and the IPv4's, marked up. */
export function serverPrice(input: {
  listMonthly: number;
  ipv4Monthly: number;
  markupPercent: number;
}): number {
  return tidyMicros(
    marked(
      microsOf(input.listMonthly) + microsOf(input.ipv4Monthly),
      input.markupPercent,
    ),
  );
}

/**
 * Backups' monthly price: the provider's backup percentage of the size's own
 * list price (not the IPv4's), marked up.
 */
export function backupsPrice(input: {
  listMonthly: number;
  backupPercent: number;
  markupPercent: number;
}): number {
  const backups = Math.round(
    (microsOf(input.listMonthly) * input.backupPercent) / 100,
  );
  return tidyMicros(marked(backups, input.markupPercent));
}

/** Extra storage's monthly price: the per-GB list price times the size, marked up, rounded once. */
export function storagePrice(input: {
  sizeGb: number;
  perGbMonthly: number;
  markupPercent: number;
}): number {
  return tidyMicros(
    marked(microsOf(input.perGbMonthly) * input.sizeGb, input.markupPercent),
  );
}
