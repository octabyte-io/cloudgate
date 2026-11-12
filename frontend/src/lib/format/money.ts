/**
 * A price in US dollars, as a plan line or a card shows it: `$19.40`.
 *
 * Promoted here (§1.4) once the Stack VM card and a plan's final-snapshot
 * line had each written their own. A positive amount under a cent, which a
 * small snapshot's monthly price can be, reads as `$0.01` rather than
 * `$0.00`: a thing that costs something never reads as free.
 */
export function usd(amount: number): string {
  return `$${(amount > 0 && amount < 0.01 ? 0.01 : amount).toFixed(2)}`;
}
