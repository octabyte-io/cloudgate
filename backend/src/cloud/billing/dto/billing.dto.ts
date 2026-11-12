import { returnToSchema } from 'api-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PLAN_NAMES } from '../billing.plans';

/**
 * Body of POST /billing/add-ons: how many Add-ons, each one more Server and one
 * more Cloud Environment on top of the plan's 3. The service raises it to cover
 * what the Organization already uses.
 */
export const addOnsSchema = z.object({
  addOns: z.number().int().min(0).max(1000),
});

export class AddOnsDto extends createZodDto(addOnsSchema) {}

/**
 * Body of POST /billing/checkout: the plan chosen, Starter or Business, and its
 * Add-ons, counted as for POST /billing/add-ons. `returnTo` is the console path
 * Checkout returns to (the get-started wizard's, ADR-0073); left out, it
 * returns to the Billing page.
 */
export const checkoutSchema = addOnsSchema.extend({
  plan: z.enum(PLAN_NAMES),
  returnTo: returnToSchema.optional(),
});

export class CheckoutDto extends createZodDto(checkoutSchema) {}

/** Body of PATCH /billing/invoice-notifications. */
export const updateInvoiceNotificationsSchema = z.object({
  enabled: z.boolean(),
});

export class UpdateInvoiceNotificationsDto extends createZodDto(
  updateInvoiceNotificationsSchema,
) {}

/**
 * Body of POST /billing/upgrade: the proration time GET
 * /billing/upgrade-preview answered, Unix seconds, so the upgrade charges the
 * amount that preview showed.
 */
export const upgradeSchema = z.object({
  prorationDate: z.number().int().positive(),
});

export class UpgradeDto extends createZodDto(upgradeSchema) {}
