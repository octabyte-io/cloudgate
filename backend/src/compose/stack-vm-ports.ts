import { stringify } from 'yaml';

import { listComposePublishedPorts, parseComposeFile } from './compose-file';

/** A compose service's Domain on a Stack VM, as its deploy publishes it. */
export interface StackVmRoute {
  readonly host: string;
  readonly serviceName: string;
  /** The Domain's port: the container's, published on the Stack VM at the same number. */
  readonly port: number;
}

/** Where a Domain's container port is published on the machine. */
export interface HostSide {
  /** The address it is bound to; every address when absent. */
  readonly ip?: string;
  readonly port: number;
}

/** A Stack VM's host side: the container port's own number, every address. */
const SAME_NUMBER = (route: StackVmRoute): HostSide => ({ port: route.port });

/**
 * **How a Domain's port reaches a Stack VM** (#1371). A Domain's `port` is
 * the container port its service listens on, as on Traefik. On a Stack VM
 * there is no Traefik: the Environment network's load balancer reaches the
 * Stack VM's private address, so the deploy publishes that container port
 * on the Stack VM **at the same number** (`"3000:3000"`), and the Stack VM's
 * definition makes the target and opens its security group (or firewall)
 * to the load balancer on that port alone. The operator writes no `ports:`
 * line for it, and a Domain means the same thing on a Server and in a
 * cloud.
 *
 * A port the service already publishes at the same number is left as it
 * is. Refused, naming the field: a service publishing the Domain's port on
 * the Stack VM to another container port, two services whose Domains reach
 * the same port (a Stack VM publishes a port once), and a Domain naming a
 * service the file does not declare. With no Domain, the file is handed
 * back as it came.
 *
 * `hostSide` is the one thing `cloudgate template try` changes (spec #5):
 * it publishes each Domain on a free loopback port it picked
 * (`127.0.0.1:<port>:<container port>`) by the same rules. A Stack VM's
 * deploy leaves it out.
 */
export function publishStackVmPorts(
  content: string,
  routes: readonly StackVmRoute[],
  hostSide: (route: StackVmRoute) => HostSide = SAME_NUMBER,
): string {
  if (routes.length === 0) return content;
  const spec = parseComposeFile(content) as {
    services?: Record<string, { ports?: unknown[] } | null>;
  } | null;
  const services = spec?.services ?? {};

  const ownerOf = new Map<
    number,
    { serviceName: string; target: number; ip?: string }
  >();
  for (const route of routes) {
    const host = hostSide(route);
    const owner = ownerOf.get(host.port);
    if (owner && owner.serviceName !== route.serviceName) {
      throw new Error(
        `port: the Domains of services ${owner.serviceName} and ${route.serviceName} both reach port ${host.port}, which a Stack VM publishes once. Give one of them another port`,
      );
    }
    ownerOf.set(host.port, {
      serviceName: route.serviceName,
      target: route.port,
      ip: host.ip,
    });
    if (!(route.serviceName in services)) {
      throw new Error(
        `Domain "${route.host}" is attached to service "${route.serviceName}" which does not exist in the compose file`,
      );
    }
  }

  const published = listComposePublishedPorts(content);
  for (const [port, { serviceName, target, ip }] of ownerOf) {
    const already = published.find((one) => one.published === port);
    if (already && already.target !== target) {
      throw new Error(
        `ports: service ${already.service} publishes ${port} on its Stack VM to container port ${already.target}, but its Domain reaches container port ${target} on that port. Remove that line from the compose file, or give the Domain port ${already.target}`,
      );
    }
    if (already) continue;
    const service = (services[serviceName] ??= {});
    const mapping = `${port}:${target}`;
    service.ports = [
      ...(service.ports ?? []),
      ip === undefined ? mapping : `${ip}:${mapping}`,
    ];
  }
  return stringify(spec, { lineWidth: 1000 });
}
