import { returnToSchema } from 'api-schemas';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { STORAGE_MAX_GB, STORAGE_MIN_GB } from '../catalogue';

/** Extra storage, in whole GB, between the provider's Volume limits. */
const storageGbSchema = z
  .number()
  .int('Extra storage is a whole number of GB.')
  .min(STORAGE_MIN_GB, `Extra storage is at least ${STORAGE_MIN_GB} GB.`)
  .max(
    STORAGE_MAX_GB,
    `Extra storage is at most ${STORAGE_MAX_GB.toLocaleString('en-US')} GB.`,
  );

/** The size and Location chosen, by the catalogue's ids. */
const choiceSchema = z.object({
  serverType: z.string().trim().min(1, 'Pick a size.'),
  location: z.string().trim().min(1, 'Pick a location.'),
});

/** `GET /bought-servers/today`: the Today box for a choice, backups and extra storage included when chosen. */
export const todayQuerySchema = choiceSchema.extend({
  backups: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
  storageGb: z.coerce.number().pipe(storageGbSchema).optional(),
});

export class TodayQueryDto extends createZodDto(todayQuerySchema) {}

/** `POST /bought-servers`: Buy. */
export const buySchema = choiceSchema.extend({
  name: z.string().trim().max(100).optional(),
  /** Backups: their own line, and on from the moment the machine is made. */
  backups: z.boolean().optional(),
  /** Extra storage in GB: its own line, attached and mounted once setup finishes. */
  storageGb: storageGbSchema.optional(),
  /** The terms box: Buy is refused unless it is ticked. */
  termsAccepted: z.literal(true, {
    error: 'Tick the box to accept the terms.',
  }),
  /** The Today box's proration time, so the charge is the amount shown. */
  prorationDate: z.number().int().positive(),
  /**
   * With no plan, the console path the Checkout that starts it returns to,
   * paid or cancelled (the get-started wizard's, ADR-0073). Left out, it
   * returns to Servers.
   */
  returnTo: returnToSchema.optional(),
});

export class BuyDto extends createZodDto(buySchema) {}

/**
 * `POST /bought-servers/:id/finish-paying`: optionally the console path the
 * wizard came from. Accepted for the wizard's one call shape, but a Checkout
 * keeps the return addresses Buy gave it (Stripe cannot change an open
 * session's), and a 3D Secure invoice page has none, so it changes nothing
 * about where the browser returns; Buy's own `returnTo` is what does.
 *
 * `.default({})` on the whole body, as `triggerDeploymentSchema`'s: Express
 * hands Nest `undefined` for a POST with no body, which the console's
 * *Finish paying* has always sent, and an object schema refuses that.
 */
export const finishPayingSchema = z
  .object({
    returnTo: returnToSchema.optional(),
  })
  .default({});

export class FinishPayingDto extends createZodDto(finishPayingSchema) {}

/** `PUT /bought-servers/:id/backups`: backups on or off on a Ready Bought Server. */
export const backupsSchema = z.object({
  enabled: z.boolean(),
});

export class BackupsDto extends createZodDto(backupsSchema) {}

/** `PUT /bought-servers/:id/storage`: grow a Ready Bought Server's extra storage. It never shrinks. */
export const storageSchema = z.object({
  sizeGb: storageGbSchema,
});

export class StorageDto extends createZodDto(storageSchema) {}

/** `PUT /bought-servers/:id/size`: a new size, up or down, on a Ready Bought Server. */
export const sizeSchema = z.object({
  serverType: z.string().trim().min(1, 'Pick a size.'),
});

export class SizeDto extends createZodDto(sizeSchema) {}
