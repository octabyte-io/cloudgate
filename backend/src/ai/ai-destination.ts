import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { publicAddressOf } from '../outbound/outbound-address';
import type { AddressResolver } from '../outbound/outbound-address';

/**
 * Where the platform host may be pointed by a caller-supplied `apiUrl`.
 *
 * `POST /ai/models` and `POST /ai/test-connection` take a URL out of the
 * request body and make the backend fetch it, so the request they issue leaves
 * from *inside* the network the platform host sits in — the Docker daemon on
 * TCP, Traefik's admin API, `169.254.169.254` on a cloud host, anything on the
 * private network that answers a GET. Gating both on `ensureOwnerOrAdmin` (the
 * other half of the AI-probe gating) removes plain members from that primitive, and no more:
 * an owner or admin of *any* Organization on the instance still holds it, which
 * on a multi-organization install is a second Organization's owner reaching a
 * network they are not on.
 *
 * So the destination is checked as well as the caller, and the check is
 * ADR-0013's question rather than a new one: *do you administer this instance*.
 * A private-network destination for the platform host to dial is an
 * instance-wide thing to choose, exactly like the Traefik files and the host
 * shell that ADR moved, and `PermissionService.checkInstanceAuthority` is the
 * boundary it settled on. `AiService.assertDestinationAllowed` asks it first
 * and skips this check entirely when it passes — an instance owner or admin
 * already has a root shell on this host (ADR-0010, ADR-0013), so refusing them
 * a URL buys nothing and would break the flow below.
 *
 * **A flat refusal of private addresses was rejected, and this is the reason.**
 * Ollama is a first-class provider here — `getProviderName` sniffs it off
 * `:11434` — and a self-hosted operator running it on the box or on the LAN is
 * the case the product is *for*. On the single-organization install
 * `deploy/install.sh` produces, the one Organization is the instance
 * organization (ADR-0013), so that operator passes the authority check and
 * `http://localhost:11434` keeps working; the caller this refuses is the one
 * with no claim on the host.
 *
 * **Requiring the `apiUrl` to match a stored `Ai` row was the other candidate
 * and the product rules it out.** `POST /ai/models` is reached from the Add a
 * provider dialog, precisely before any row exists (`model-lookup.tsx`), and
 * `POST /ai/test-connection` is the credential-taking half of the
 * test-before-saving button `resource-spec.ts` documents. Both are called with
 * nothing saved, so a stored-row constraint would refuse the only order the
 * console can work in.
 *
 * **This check is where the URL enters; the dial is guarded separately.**
 * The check runs on the name's resolution *now*, which on its own left two
 * holes: a name that resolves publicly here and privately at connect time,
 * and a public provider that answers with a redirect to an internal address —
 * `fetch` follows it, and `getModels` used to quote the body back. Both are
 * closed at the dial: every request to a provider (`getModels` and every
 * provider factory, through `selectAIProvider`'s required `fetch`) goes
 * through `OutboundAddressGuard.fetchFor`, scoped to the provider's
 * Organization, which checks every connection, redirect hops included, and
 * dials the address it checked. The instance organization is exempt there for
 * the reason it is exempt here.
 */

/**
 * The address rule itself — the private ranges, `isPrivateAddress` and the
 * `ADDRESS_RESOLVER` seam — moved to `outbound/outbound-address.ts` when the
 * other surfaces that dial a customer's host took it up. Re-exported
 * under the names this module always had, which is what its callers and the
 * suites that override `ADDRESS_RESOLVER` import.
 */
export {
  ADDRESS_RESOLVER,
  addressResolverProvider,
  isPrivateAddress,
} from '../outbound/outbound-address';
export type { AddressResolver } from '../outbound/outbound-address';

/**
 * One sentence for every way the destination is refused, for
 * `INSTANCE_AUTHORITY_REFUSAL`'s reason: which private range a name landed in,
 * and whether it resolved at all, are facts about the host's own network and a
 * refused caller is not owed them. Split-horizon DNS makes that a real oracle
 * rather than a theoretical one — the answer from inside can differ from the
 * one the caller can get for themselves.
 */
export const PRIVATE_DESTINATION_REFUSAL =
  'Only an owner or admin of the instance organization can point the platform host at this address';

/**
 * Refuse an `apiUrl` the platform host must not be pointed at by this caller.
 *
 * Both branches fail closed. A literal address is decided on the spot; a name
 * is refused unless **every** address it resolves to is public, and refused if
 * it resolves to nothing or cannot be resolved — an unresolvable name is a
 * destination this cannot vouch for, and the fetch it guards would have failed
 * anyway.
 *
 * `ForbiddenException` and not `BadRequestException` for the address itself:
 * the very same URL is accepted from a caller with instance authority, so the
 * refusal is about who is asking. A URL that is not an http(s) URL at all is
 * the request being malformed and stays a 400.
 */
export async function assertPublicApiUrl(
  apiUrl: string,
  resolve: AddressResolver,
): Promise<void> {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new BadRequestException('apiUrl must be an absolute http(s) URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new BadRequestException('apiUrl must be an absolute http(s) URL');
  }

  if ((await publicAddressOf(url.hostname, resolve)) === null) {
    throw new ForbiddenException(PRIVATE_DESTINATION_REFUSAL);
  }
}
