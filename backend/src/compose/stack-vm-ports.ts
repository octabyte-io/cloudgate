import { stringify } from 'yaml';

import { listComposePublishedPorts, parseComposeFile } from './compose.utils';

/** A compose service's Domain on a Stack VM, as its deploy publishes it. */
export interface StackVmRoute {
  readonly host: string;
  readonly serviceName: string;
  /** The Domain's port: the container's, published on the Stack VM at the same number. */
  readonly port: number;
}

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
 */
export function publishStackVmPorts(
  content: string,
  routes: readonly StackVmRoute[],
): string {
  if (routes.length === 0) return content;
  const spec = parseComposeFile(content) as {
    services?: Record<string, { ports?: unknown[] } | null>;
  } | null;
  const services = spec?.services ?? {};

  const ownerOf = new Map<number, string>();
  for (const route of routes) {
    const owner = ownerOf.get(route.port);
    if (owner && owner !== route.serviceName) {
      throw new Error(
        `port: the Domains of services ${owner} and ${route.serviceName} both reach port ${route.port}, which a Stack VM publishes once. Give one of them another port`,
      );
    }
    ownerOf.set(route.port, route.serviceName);
    if (!(route.serviceName in services)) {
      throw new Error(
        `Domain "${route.host}" is attached to service "${route.serviceName}" which does not exist in the compose file`,
      );
    }
  }

  const published = listComposePublishedPorts(content);
  for (const [port, serviceName] of ownerOf) {
    const already = published.find((one) => one.published === port);
    if (already && already.target !== port) {
      throw new Error(
        `ports: service ${already.service} publishes ${port} on its Stack VM to container port ${already.target}, but its Domain reaches container port ${port} on that port. Remove that line from the compose file, or give the Domain port ${already.target}`,
      );
    }
    if (already) continue;
    const service = (services[serviceName] ??= {});
    service.ports = [...(service.ports ?? []), `${port}:${port}`];
  }
  return stringify(spec, { lineWidth: 1000 });
}
