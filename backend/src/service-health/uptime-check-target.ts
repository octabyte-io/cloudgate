import type { ServiceType } from '../applications/application.schema';
import type { Domain } from '../domains/domain.schema';

/**
 * The URL an HTTP check requests: its Domain's scheme, host and path as the
 * Domain row says them now, so a check follows an edited Domain.
 *
 * The Domain's `port` is not part of it: that is the container port Traefik
 * forwards to, and a client reaches the Domain on 80 or 443 like anyone else.
 */
export function httpTargetUrl(
  target: Pick<Domain, 'host' | 'https' | 'path'>,
): URL {
  const path = target.path?.startsWith('/')
    ? target.path
    : `/${target.path ?? ''}`;
  return new URL(`${target.https ? 'https' : 'http'}://${target.host}${path}`);
}

/**
 * A TCP check's target as a person reads it: `host:port`, with an IPv6
 * address bracketed so the port is not read as part of it.
 */
export function tcpAddress(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

/**
 * Where a Service's Health tab is in the console, for the Notification's link:
 * `DeploymentNotifierAdapter`'s console paths, with the `health` tab
 * after Domains.
 */
export function healthTabPath(
  serviceType: ServiceType,
  serviceId: string,
): string {
  switch (serviceType) {
    case 'application':
      return `/applications/${serviceId}/health`;
    case 'compose':
      return `/compose/${serviceId}/health`;
    default:
      return `/databases/${serviceType}/${serviceId}/health`;
  }
}
