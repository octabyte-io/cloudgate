import { ConflictException } from '@nestjs/common';

import type { WorkloadPresence } from './workload-presence';

/**
 * The 409 a Server-hosted Application, database or Compose stack's Delete
 * answers when it could not confirm the workload gone, so it kept the row
 * named so the console can offer the forced Delete.
 *
 * Two codes, because the console says two different things: a workload Docker
 * still reports is one to stop first, and a Server that did not answer is one
 * to wait for. Both may be forced; the code, not the sentence, is what a client
 * branches on (`AllExceptionsFilter`'s `code`, H-26). `message` keeps the
 * backend's own words for an API caller, `?force=true` hint included; the
 * console writes its own and never shows that parameter.
 *
 * Not used on a cloud Delete: there the row stays by rule until the Cloud run
 * ends clean, with Retry and Forget instead of a force (ADR-0038).
 */
export const WORKLOAD_STILL_PRESENT_CODE = 'WORKLOAD_STILL_PRESENT';
export const WORKLOAD_PRESENCE_UNKNOWN_CODE = 'WORKLOAD_PRESENCE_UNKNOWN';

export function workloadKeptRefusal(
  presence: Exclude<WorkloadPresence, 'absent'>,
  message: string,
): ConflictException {
  return new ConflictException({
    message,
    code:
      presence === 'present'
        ? WORKLOAD_STILL_PRESENT_CODE
        : WORKLOAD_PRESENCE_UNKNOWN_CODE,
  });
}

/**
 * The 409 a Domain, redirect or basic-auth user Delete answers when the
 * Server its routing is written on could not be reached, so the row was kept
 * (#1417).
 *
 * Here, beside the two above, because it is the same refusal one step along —
 * kept, to wait for the Server or to force — about a different thing: not a
 * workload but a router in that Server's Traefik file, which a forced Delete
 * leaves there and names as a `'traefik-config'` in `unreclaimedArtifacts`
 * (`traefik/routing-delete.ts`). Its own code rather than
 * `WORKLOAD_PRESENCE_UNKNOWN`, because a client branching on that one says a
 * workload may still be running, and none is: the route just goes on
 * answering from the file until the file is rewritten.
 */
export const ROUTE_REMOVAL_UNREACHABLE_CODE = 'ROUTE_REMOVAL_UNREACHABLE';

export function routeKeptRefusal(message: string): ConflictException {
  return new ConflictException({
    message,
    code: ROUTE_REMOVAL_UNREACHABLE_CODE,
  });
}
