import { BadRequestException } from '@nestjs/common';

/**
 * The refusal code a client branches on (ADR-0005) when a clone on the
 * platform host asks for a dial that cannot be held to a checked address:
 * submodules, or the `git://` protocol.
 */
export const PLATFORM_HOST_CLONE_REFUSED_CODE = 'PLATFORM_HOST_CLONE_REFUSED';

/**
 * Why submodules are refused there. `--recurse-submodules` has git dial every
 * URL in the repository's own `.gitmodules` — written by whoever can push to
 * it, read only by git, after the address check has run — and the clone's
 * output goes into the Deployment log, so each one would be a probe of the
 * platform host's network with its answer printed.
 */
export const SUBMODULES_REFUSAL =
  "Submodules are not cloned on this Cloudgate's own host: git would dial each submodule's URL unchecked. Turn submodules off, or build on one of your Servers.";

/**
 * Why a `git://` URL is refused there. git's own daemon protocol is dialled by
 * git with no option to hand it the checked address, unlike curl for http(s)
 * and ssh for an ssh URL, so a name could resolve elsewhere between the check
 * and the dial.
 */
export const GIT_PROTOCOL_REFUSAL =
  "git:// URLs are not cloned on this Cloudgate's own host. Use the repository's https:// or ssh:// URL.";

/** Why a connection's base URL that is not http(s) is refused there. */
export const BASE_URL_REFUSAL =
  "A git provider's URL must be an http:// or https:// URL with no user in it to be cloned on this Cloudgate's own host.";

/**
 * The 400 for one of those, naming the field to change, the way
 * `outboundAddressRefused` names the field a refused host came from.
 */
export function platformHostCloneRefused(
  field: string,
  reason: string,
): BadRequestException {
  return new BadRequestException({
    message: `${field}: ${reason}`,
    code: PLATFORM_HOST_CLONE_REFUSED_CODE,
    field,
  });
}
