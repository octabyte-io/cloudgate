import { parse, stringify } from 'yaml';
import type {
  ComposeServiceNetworks,
  ComposeServiceSpec,
  ComposeSpecification,
} from '../compose/compose.types';
import {
  basicAuthorization,
  TRACE_CREDENTIAL_USER,
  otlpHeaders,
  traceStoreNetworkName,
} from './trace-store';
import type { TraceWiring } from './trace-store';
import type { TraceStore } from './trace-store.schema';

// A traced **Compose**'s wiring (ADR-0028): what its deploy writes into
// the converted file so that every inner service sends spans to the Compose's
// one Trace store, told apart by `service.name`.
//
// A Compose's `.env` only feeds `${VAR}` interpolation, so it cannot hand an
// inner service a variable; the converted file — Cloudgate's own copy, which
// it already rewrites for routing and platform defaults — is where a service's
// environment is written. Deploy only: `GET /compose/:id/converted` never runs
// this, because the header carries the Service's ingest credential.

/** What a traced Compose's deploy writes into its converted file. */
export interface ComposeTraceWiring {
  /** The `OTEL_EXPORTER_OTLP_*` variables, `traceWiringEnv`'s. */
  env: Record<string, string>;
  /** The network the Compose's Trace store is on, `traceStoreNetworkName`'s. */
  network: string;
}

/** A traced Compose's deploy wiring, off its store's. */
export const composeTraceWiringOf = (
  wiring: TraceWiring,
): ComposeTraceWiring => ({
  env: wiring.env,
  network: traceStoreNetworkName(wiring.store.appName),
});

/** The variable each inner service is named by, unless its author named it. */
const SERVICE_NAME_VARIABLE = 'OTEL_SERVICE_NAME';

/** `OTEL_RESOURCE_ATTRIBUTES` carrying a `service.name`, which names it too. */
const NAMES_SERVICE = /(^|,)\s*service\.name\s*=/;

type Environment = Record<string, unknown> | string[];

/** `KEY` of a list-form entry: `KEY=value`, or a bare `KEY` passed through. */
const keyOf = (entry: string): string => {
  const at = entry.indexOf('=');
  return at < 0 ? entry : entry.slice(0, at);
};

/** Whether the author already names this service to its SDK. */
function namesItself(environment: Environment | undefined): boolean {
  if (!environment) return false;
  if (Array.isArray(environment)) {
    return environment.some(
      (entry) =>
        keyOf(entry) === SERVICE_NAME_VARIABLE ||
        (keyOf(entry) === 'OTEL_RESOURCE_ATTRIBUTES' &&
          NAMES_SERVICE.test(entry.slice(entry.indexOf('=') + 1))),
    );
  }
  const attributes = environment.OTEL_RESOURCE_ATTRIBUTES;
  return (
    SERVICE_NAME_VARIABLE in environment ||
    (typeof attributes === 'string' && NAMES_SERVICE.test(attributes))
  );
}

/**
 * A new environment, never the parsed one: two services can share one object
 * through a YAML alias, and each must be named by its own name.
 *
 * - The OTLP variables replace any the author set, as they replace an env row
 *   on an Application: the store is where this Service's spans go.
 * - `OTEL_SERVICE_NAME` defaults to the service's own name, so the Traces tab
 *   tells inner services apart; an author who set it, or set `service.name` in
 *   `OTEL_RESOURCE_ATTRIBUTES`, keeps theirs. Presence is the author's
 *   statement, `applyComposeDefaults`' rule: a bare `OTEL_SERVICE_NAME` passed
 *   through from the shell is theirs too.
 */
function wiredEnvironment(
  environment: Environment | undefined,
  serviceName: string,
  wiring: Record<string, string>,
): Environment {
  const named = namesItself(environment);
  if (Array.isArray(environment)) {
    return [
      ...environment.filter((entry) => !(keyOf(entry) in wiring)),
      // Before the OTLP variables, which a second pass removes and appends
      // again, so the pass is a no-op.
      ...(named ? [] : [`${SERVICE_NAME_VARIABLE}=${serviceName}`]),
      ...Object.entries(wiring).map(([key, value]) => `${key}=${value}`),
    ];
  }
  return {
    ...environment,
    ...wiring,
    ...(named ? {} : { [SERVICE_NAME_VARIABLE]: serviceName }),
  };
}

/**
 * The service's networks with the store's added, as a new value. A service
 * that declared none is on `default`, and stays there.
 */
function joinedNetworks(
  networks: ComposeServiceNetworks | undefined,
  network: string,
): ComposeServiceNetworks {
  if (networks === undefined || networks === null) return ['default', network];
  if (Array.isArray(networks)) {
    return networks.includes(network) ? [...networks] : [...networks, network];
  }
  return { ...networks, [network]: networks[network] ?? {} };
}

/**
 * The converted file with a traced Compose's wiring written into every inner
 * service: the three OTLP variables, a default `OTEL_SERVICE_NAME`, and
 * the store's network, declared external at the root.
 *
 * **Its own network, not `cloudgate-network`.** Only a routed inner service is
 * on `cloudgate-network`; joining every inner service to it would put a
 * Compose's `db` and `redis` under those names on the network every Service
 * shares, where another Compose's `db` answers the same name. The store's
 * network holds this Compose's services and its store and nothing else, so it
 * also keeps an isolated Compose isolated.
 *
 * A service with a `network_mode` joins nothing: `service:<name>` shares a
 * network namespace that is joined through its own service, and `host` or
 * `none` cannot join a network at all. It still gets the variables.
 *
 * A no-op on a second pass over its own output.
 */
export function injectComposeTraceWiring(
  converted: string,
  wiring: ComposeTraceWiring,
): string {
  // `parseComposeFile`'s options: the file already passed them on its way here
  // (`writeDomainsToCompose`), and the warnings stay out of the log.
  const spec = parse(converted, {
    maxAliasCount: 10_000,
    logLevel: 'error',
  }) as ComposeSpecification;
  const services = Object.entries(spec.services ?? {});
  if (services.length === 0) return converted;
  const wired: Record<string, ComposeServiceSpec> = {};
  for (const [name, service] of services) {
    const next: ComposeServiceSpec = {
      ...service,
      environment: wiredEnvironment(
        service.environment as Environment | undefined,
        name,
        wiring.env,
      ),
    };
    if (service.network_mode === undefined || service.network_mode === null) {
      next.networks = joinedNetworks(service.networks, wiring.network);
    }
    wired[name] = next;
  }
  spec.services = wired;
  spec.networks = {
    ...spec.networks,
    [wiring.network]: { external: true },
  };
  return stringify(spec, { lineWidth: 1000 });
}

/** What {@link withoutTraceCredential} writes where the header value was. */
export const REDACTED_TRACE_HEADER = 'Authorization=<redacted>';

/**
 * A converted file with the Compose's ingest credential taken out, for
 * `GET /compose/:id/converted`. That route never runs
 * {@link injectComposeTraceWiring}, but for a git-sourced Compose it reads the
 * converted file its last deploy left on the Server, and that file does carry
 * it. The credential is removed by value, in each spelling a file could hold
 * it — the header value the deploy wrote, its base64, and the credential
 * itself — so the route never answers it, whether traces are on, off, or were
 * on at the last deploy.
 */
export function withoutTraceCredential(
  converted: string,
  row: Pick<TraceStore, 'credential'> | null,
): string {
  if (!row?.credential) return converted;
  const header = otlpHeaders(row.credential);
  const base64 = basicAuthorization(
    TRACE_CREDENTIAL_USER,
    row.credential,
  ).slice('Basic '.length);
  return converted
    .replaceAll(header, REDACTED_TRACE_HEADER)
    .replaceAll(base64, '<redacted>')
    .replaceAll(row.credential, '<redacted>');
}
