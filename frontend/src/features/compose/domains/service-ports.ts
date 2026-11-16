import { parse } from "yaml";

import type { Domain } from "@/lib/api/endpoints/domains";

/**
 * The container port each compose service is known to listen on, which the
 * Domain dialog moves its Container port to when that service is picked.
 *
 * Two sources, the first that knows winning:
 *
 * 1. A Domain this stack already routes to the service. That port is the one
 *    Traefik reaches it on today, and it is how a Template's service, whose
 *    file often declares no port at all, still has one.
 * 2. The compose file: the service's first `expose` entry, else the container
 *    side of its first `ports` entry (`"8080:80"` is 80, `"127.0.0.1:8080:80/tcp"`
 *    is 80, the long form's `target`).
 *
 * A service neither names is left out, and the dialog keeps whatever port it
 * shows: guessing one would be a third source nobody wrote down.
 */
export function composeServicePorts(
  content: string | undefined,
  domains: readonly Pick<Domain, "serviceName" | "port">[] = [],
): Record<string, number> {
  const ports: Record<string, number> = {};
  for (const [name, service] of Object.entries(declaredServices(content))) {
    const port =
      firstPort(service?.expose, exposedPort) ??
      firstPort(service?.ports, publishedTarget);
    if (port !== null) ports[name] = port;
  }
  for (const { serviceName, port } of domains) {
    if (serviceName && validPort(port)) ports[serviceName] = port;
  }
  return ports;
}

type ServiceSpec = { expose?: unknown; ports?: unknown } | null | undefined;

function declaredServices(
  content: string | undefined,
): Record<string, ServiceSpec> {
  if (!content) return {};
  try {
    const spec = parse(content) as { services?: unknown } | null;
    const services = spec?.services;
    return services && typeof services === "object"
      ? (services as Record<string, ServiceSpec>)
      : {};
  } catch {
    return {};
  }
}

function firstPort(
  list: unknown,
  read: (entry: unknown) => number | null,
): number | null {
  if (!Array.isArray(list)) return null;
  for (const entry of list) {
    const port = read(entry);
    if (port !== null) return port;
  }
  return null;
}

/** `expose: ["3000", 8080, "9000-9010"]`: the first port of the entry. */
function exposedPort(entry: unknown): number | null {
  return portOf(String(entry).split("/")[0].split("-")[0]);
}

/** A `ports` entry's container side, short form or long. */
function publishedTarget(entry: unknown): number | null {
  if (entry && typeof entry === "object") {
    return portOf(String((entry as { target?: unknown }).target ?? ""));
  }
  const withoutProtocol = String(entry).split("/")[0];
  // `[::1]:8080:80`: the address can hold colons, the container side cannot.
  const containerSide = withoutProtocol.slice(
    withoutProtocol.lastIndexOf(":") + 1,
  );
  return portOf(containerSide.split("-")[0]);
}

function portOf(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const port = Number(text);
  return validPort(port) ? port : null;
}

function validPort(port: unknown): port is number {
  return (
    Number.isInteger(port) && (port as number) >= 1 && (port as number) <= 65535
  );
}
