import { formatMoney, type PriceView } from "@/lib/api/endpoints/billing";

/** A monthly price as a person reads it. */
export function priceText(price: PriceView): string {
  if (price.unitAmount == null) return "Price set at Stripe";
  const amount = formatMoney(price.unitAmount, price.currency);
  return price.interval ? `${amount} per ${price.interval}` : amount;
}

/**
 * The plan plus `addOns` Add-ons, a month, as money — or null when the two
 * prices cannot be added: a tiered price, another currency or interval.
 */
export function monthlyTotal(
  plan: PriceView,
  addOn: PriceView,
  addOns: number,
): string | null {
  if (plan.unitAmount == null) return null;
  if (addOns > 0) {
    if (addOn.unitAmount == null) return null;
    if (addOn.currency !== plan.currency) return null;
    if (addOn.interval !== plan.interval) return null;
  }
  const amount = plan.unitAmount + addOns * (addOn.unitAmount ?? 0);
  return formatMoney(amount, plan.currency);
}
