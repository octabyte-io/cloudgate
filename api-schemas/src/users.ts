import { z } from 'zod';

/**
 * `GET /users/me/whoami`: who a request is made as, where, and with what.
 *
 * The facts `cloudgate whoami` prints, in one read: the email, the Organization
 * the request acts in, and — when the request carries a Personal key — that
 * key, so the CLI can say when it ends. No other route could answer the last
 * one: `GET /users/me/api-keys` refuses a key, on purpose, because a
 * key that can list keys can find its siblings. This answers only the key the
 * request was made with, so it reveals nothing the caller does not already
 * hold.
 *
 * `key` is null for a console session; `expiresAt` is null for a key that
 * never ends.
 */
export const whoamiSchema = z.object({
  email: z.string(),
  organization: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable(),
  key: z
    .object({
      id: z.string(),
      name: z.string().nullable(),
      /** The key's first characters, as the console shows them. */
      start: z.string().nullable(),
      /** ISO-8601, or null for a key that does not end. */
      expiresAt: z.string().nullable(),
    })
    .nullable(),
});

export type Whoami = z.infer<typeof whoamiSchema>;
