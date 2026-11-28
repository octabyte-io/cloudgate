import { wholeUsd } from "../buy/buy-model";

/** US cents a month as whole dollars: `$5/month`. */
export function perMonth(cents: number): string {
  return `${wholeUsd(cents / 100)}/month`;
}
