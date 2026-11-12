import { BadRequestException } from '@nestjs/common';

/**
 * The refusal code a client branches on (ADR-0005) when the Hosted instance
 * is asked to put a customer's work on its own host (ADR-0053).
 */
export const PLATFORM_HOST_REFUSED_CODE = 'PLATFORM_HOST_REFUSED';

/**
 * The two fixed sentences, one per kind of work (ADR-0053). `services` is
 * said to a Service or an Environment, `checks` to a connection test run on
 * the caller's behalf (the rclone destination and restore probes, the
 * registry `docker login` probe).
 */
export const PLATFORM_HOST_REFUSALS = {
  services:
    "This Cloudgate doesn't run Services on its own host. Choose one of your Servers or Cloud accounts.",
  checks:
    "This Cloudgate doesn't run checks on its own host. Choose one of your Servers to run it from.",
} as const;

/** Which sentence a refusal says. */
export type PlatformHostWork = keyof typeof PLATFORM_HOST_REFUSALS;

/** The 400 itself, for `InstanceMode.refusePlatformHost` to throw. */
export function platformHostRefused(
  work: PlatformHostWork,
): BadRequestException {
  return new BadRequestException({
    message: PLATFORM_HOST_REFUSALS[work],
    code: PLATFORM_HOST_REFUSED_CODE,
  });
}
