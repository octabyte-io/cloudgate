import { z } from 'zod';

/**
 * `GET /settings/about`: the public "this is a Cloudgate" answer.
 *
 * Read with no credential, before the Cloudgate CLI sends a key anywhere: an
 * address that does not answer this — a console page, someone else's site, a
 * typo that resolves — is refused, and the key never leaves the machine.
 *
 * - `product` is always `"cloudgate"`; it is what tells a Cloudgate apart from
 *   any other JSON-answering site.
 * - `version` is the server's (`backend/package.json`), which the CLI compares
 *   with the lowest version it supports.
 * - `apiUrl` is the API's own origin, where the browser and the CLI dial
 *   WebSockets, since the console proxies none (`CLOUDGATE_API_URL`; null when
 *   the operator has not set it). REST still goes through the console.
 * - `mode` says whether this is the Hosted instance or a Self-hosted one
 *   (ADR-0049). The backend always sends it; it is optional here only so
 *   that the CLI, which parses this answer with this object, still recognises
 *   a Cloudgate from before `mode` was added as one.
 */
export const instanceModeSchema = z.enum(['hosted', 'self-hosted']);

export type InstanceModeName = z.infer<typeof instanceModeSchema>;

export const aboutSchema = z.object({
  product: z.literal('cloudgate'),
  version: z.string(),
  apiUrl: z.string().nullable(),
  mode: instanceModeSchema.optional(),
});

export type About = z.infer<typeof aboutSchema>;
