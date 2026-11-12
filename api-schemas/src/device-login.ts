import { z } from 'zod';

/**
 * `cloudgate login`'s two routes: the device flow (RFC 8628) in which
 * the person approves a code in the console and the polling CLI is handed a
 * **Personal key**, never a session.
 */

/**
 * `POST /auth/device/code`, asked with no credential and an empty body. It
 * takes nothing: no client id (the CLI is the only client) and, above all, no
 * user id, which better-auth's own route accepted from anyone and stored, so a
 * code could be bound to a person before they ever saw it.
 */
export const deviceCodeRequestSchema = z.strictObject({});

export const deviceCodeSchema = z.object({
  /** The secret the CLI polls with; never shown. */
  deviceCode: z.string(),
  /** What the person types or checks on the console's `/device` screen. */
  userCode: z.string(),
  /** Seconds the CLI waits between polls. */
  interval: z.number(),
  /** Seconds until the code ends. */
  expiresIn: z.number(),
});

export type DeviceCode = z.infer<typeof deviceCodeSchema>;

/** `POST /auth/device/token`, the CLI's poll, also with no credential. */
export const deviceTokenRequestSchema = z.strictObject({
  deviceCode: z.string().min(1),
  /** The new key's name in the person's Personal keys. */
  name: z.string().trim().min(1).max(100).optional(),
  /**
   * The id of the key this login replaces (an earlier login on the same
   * Instance). Deleted once the new key is minted, and only when it is the
   * approving person's own key.
   */
  replaces: z.string().min(1).max(200).optional(),
});

export type DeviceTokenRequest = z.infer<typeof deviceTokenRequestSchema>;

/** The poll's answer once the code is approved: the key, once. */
export const deviceTokenSchema = z.object({
  key: z.string(),
  keyId: z.string(),
  /** ISO-8601: 90 days after the login. */
  expiresAt: z.string(),
});

export type DeviceToken = z.infer<typeof deviceTokenSchema>;

/**
 * The `code` of every 400 the poll answers, RFC 8628's errors in this API's
 * spelling. The CLI keeps polling on the first two and stops on the rest.
 */
export const DEVICE_TOKEN_CODES = {
  pending: 'AUTHORIZATION_PENDING',
  slowDown: 'SLOW_DOWN',
  expired: 'EXPIRED_TOKEN',
  denied: 'ACCESS_DENIED',
  invalid: 'INVALID_GRANT',
} as const;

/** How long a key minted by `cloudgate login` lasts (CLI spec). */
export const DEVICE_LOGIN_KEY_DAYS = 90;
