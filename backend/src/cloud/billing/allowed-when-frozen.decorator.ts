import { SetMetadata } from '@nestjs/common';

/**
 * The writes a Frozen Organization's members may still make (ADR-0052).
 * Every other mutating route is refused by `FrozenGuard` with the
 * frozen error while the caller's active Organization is frozen; a route
 * carrying this decorator is let through, and says which carve-out it is:
 *
 * - `pay` — checkout, the customer portal, the Add-on quantity;
 * - `remove` — Delete a Service, an Environment, a Server (and a Project,
 *   which removes only its Environments and Services);
 * - `disconnect` — disconnecting a Cloud account;
 * - `delete-organization` — deleting the Organization itself;
 * - `detach` — "Stop paying for it" on an Organization a frozen Paying
 *   Organization pays for (ADR-0059). It buys and starts nothing: it takes
 *   an Organization off a plan nobody is paying, so its own owner can pay
 *   for it, and it is one of the two ways to clear the "Before <Paying> can
 *   move to Starter" checklist, which a lapsed payer may need to get through;
 * - `own-account` — a write to the caller's own person (profile, two-factor,
 *   Personal keys, sessions, default Organization) or to another Organization
 *   (creating one, accepting an invitation), which is not the frozen
 *   Organization's work.
 *
 * Downloading configs is a `GET`, so it needs none: no read is refused.
 * `test/coding-standards/frozen-writes-census.spec.ts` lists every route that
 * carries it, so a new one is added on purpose.
 */
export type FrozenCarveOut =
  | 'pay'
  | 'remove'
  | 'disconnect'
  | 'delete-organization'
  | 'detach'
  | 'own-account';

export const ALLOWED_WHEN_FROZEN_KEY = 'allowedWhenFrozen';

export const AllowedWhenFrozen = (carveOut: FrozenCarveOut) =>
  SetMetadata(ALLOWED_WHEN_FROZEN_KEY, carveOut);
