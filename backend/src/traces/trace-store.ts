import { eq, inArray, or } from 'drizzle-orm';
import { quote } from 'shell-quote';
import {
  CONTAINER_LOG_DRIVER,
  containerLogOptions,
} from '../common/config/container-logs';
import { ownerOnlyDirectoryCommand } from '../common/files/owner-only';
import { runTeardownSteps } from '../common/teardown-steps';
import type {
  TeardownStep,
  UnreclaimedArtifact,
} from '../common/teardown-steps';
import type { DrizzleDB } from '../db/drizzle.module';
import { traceStore } from '../db/schema';
import {
  applicationsDirectoryOn,
  composeDirectoryOn,
} from '../deployment-engine/deployment-engine.paths';
import { CONSOLE_BACKEND_PREFIX } from '../git-providers/oauth-callback.util';
import { execOnServer, execOnServerStdout } from '../remote/exec-dispatch';
import type { RemoteExecService } from '../remote/remote-exec.service';
import { CLOUDGATE_NETWORK } from '../servers/server-audit';
import {
  TRACE_STORE_CONTAINER_PREFIX,
  traceStoreContainerName,
} from './trace-store-name';
import type { TraceStore } from './trace-store.schema';

export { TRACE_STORE_CONTAINER_PREFIX, traceStoreContainerName };

// A **Trace store** on its machine (ADR-0028): what it is called, where
// its directory is, how it is started, restarted and reclaimed, and what a
// deploy hands its Service. Plain functions over `RemoteExecService` and the
// database, on `common/teardown-steps.ts`' precedent, so the engine, a
// Rollback and both Deletes reach it without importing a module — every one of
// them already holds a `db` and a `remoteExec`.

/**
 * The image the store runs: Jaeger v2, Collector, Badger and UI in one process
 * (Apache-2.0). Pinned, so a store started today and one started next month
 * read the same config.
 */
export const TRACE_STORE_IMAGE = 'jaegertracing/jaeger:2.21.0';

/**
 * The store's fixed memory limit, measured with `docker stats` on this
 * image and config under sustained OTLP/HTTP load.
 *
 * - **Most of it is Badger's, and none of it is tunable here.** Jaeger 2.21's
 *   Badger config exposes no cache or memtable size, so Badger runs its
 *   defaults: a 64 MiB memtable arena on the heap, a 128 MiB memory-mapped
 *   write-ahead file beside it, and more of both while a full one flushes.
 * - **256 MiB was killed.** At 3,000 spans/s the kernel killed the store
 *   within a minute, and on restart the replayed memtable put it straight
 *   back over `memory_limiter`, refusing every span for eleven seconds.
 * - **512 MiB held.** The peak sample was 428 MiB at 3,000 spans/s for five
 *   minutes with a search a second, and 461 MiB at 24,000 spans/s for three
 *   minutes, where `memory_limiter` refused spans (a retryable refusal) and the
 *   kernel killed nothing. A store restarted on full memtables settles at
 *   172 MiB.
 */
export const TRACE_STORE_MEMORY_LIMIT_MIB = 512;

/**
 * Jaeger's `memory_limiter`, which reads the Go heap, not the container: the
 * collector refuses spans once the heap reaches it, rather than the kernel
 * killing the process. Badger's memory-mapped files sit outside the heap,
 * which is why the container limit is so far above this and why raising the
 * container limit is not a reason to raise it. The spike allowance is the
 * collector's usual fifth.
 */
export const TRACE_STORE_MEMORY_LIMITER_MIB = 220;
export const TRACE_STORE_MEMORY_SPIKE_MIB = 40;

/** OTLP over HTTP, the one receiver the store opens. */
export const TRACE_STORE_OTLP_HTTP_PORT = 4318;

/** `OTEL_EXPORTER_OTLP_PROTOCOL`'s value for that receiver. */
export const TRACE_OTLP_PROTOCOL = 'http/protobuf';

/** The UI and its query API, reached only by the backend. */
export const TRACE_STORE_UI_PORT = 16686;

/** The user name of the Service's `basicauth` credential. */
export const TRACE_CREDENTIAL_USER = 'traces';

/** The user name of the backend's `basicauth` credential for the UI. */
export const TRACE_QUERY_USER = 'cloudgate';

/** The two Service kinds that can have a Trace store (ADR-0028). */
export type TraceServiceType = 'application' | 'compose';

export const isTraceServiceType = (
  serviceType: string,
): serviceType is TraceServiceType =>
  serviceType === 'application' || serviceType === 'compose';

/** A Service with a Trace store, and the machine the store is on. */
export interface TraceStoreOwner {
  serviceType: TraceServiceType;
  serviceId: string;
  appName: string;
  /** The Service's **run** Server; `null` is the platform host. */
  serverId: string | null;
}

/** An Application as the owner of its Trace store. */
export const applicationTraceOwner = (application: {
  applicationId: string;
  appName: string;
  serverId: string | null;
}): TraceStoreOwner => ({
  serviceType: 'application',
  serviceId: application.applicationId,
  appName: application.appName,
  serverId: application.serverId,
});

/** A Compose as the owner of its Trace store. */
export const composeTraceOwner = (compose: {
  composeId: string;
  appName: string;
  serverId: string | null;
}): TraceStoreOwner => ({
  serviceType: 'compose',
  serviceId: compose.composeId,
  appName: compose.appName,
  serverId: compose.serverId,
});

/** The `trace_store` column that names a Service of this kind. */
export const traceStoreOwnerColumn = (serviceType: TraceServiceType) =>
  serviceType === 'application'
    ? traceStore.applicationId
    : traceStore.composeId;

/** What starting the store needs beyond its owner. */
export interface TraceStoreRuntime extends TraceStoreOwner {
  retentionDays: number;
  credential: string;
  queryCredential: string;
}

/**
 * The store's directory: `traces` beside the Service's other per-Service
 * directories on its **run** Server (ADR-0018) — `{applications}/{appName}`
 * for an Application, `{compose}/{appName}` for a Compose. It holds the
 * config and Badger's data.
 */
export const traceStoreDirectoryOn = (
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>,
): string =>
  owner.serviceType === 'application'
    ? `${applicationsDirectoryOn(owner.serverId)}/${owner.appName}/traces`
    : `${composeDirectoryOn(owner.serverId)}/${owner.appName}/traces`;

/**
 * The network a **Compose**'s store is on: its own, shared with that
 * Compose's inner services and nothing else. An Application's store is on
 * `cloudgate-network`, where its Service already is; a Compose's inner services
 * are not all there, and joining them to it would put their names on the
 * network every Service shares (`compose-trace-wiring.ts` says why that is
 * wrong).
 */
export const traceStoreNetworkName = (appName: string): string =>
  `cloudgate-traces-${appName}`;

/** The network the owner's store runs on. */
export const traceStoreNetworkOf = (
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName'>,
): string =>
  owner.serviceType === 'compose'
    ? traceStoreNetworkName(owner.appName)
    : CLOUDGATE_NETWORK;

/**
 * The shell that makes a Compose's store network if it is not there:
 * attachable, so both a plain container and a Compose's services can join it,
 * and an overlay where the Server is a Swarm manager — a `stack`'s services can
 * join nothing else — and a bridge where it is not.
 */
export function ensureTraceStoreNetworkCommand(appName: string): string {
  const network = quote([traceStoreNetworkName(appName)]);
  return `docker network inspect ${network} >/dev/null 2>&1 || if [ "$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)" = active ]; then docker network create --driver overlay --attachable ${network} >/dev/null; else docker network create ${network} >/dev/null; fi`;
}

/**
 * The shell that removes a Compose's store network if it is there, exiting
 * non-zero only when it is there and could not be removed —
 * `composeNetworkReclaimCommand`'s shape.
 */
export function traceStoreNetworkReclaimCommand(appName: string): string {
  const network = quote([traceStoreNetworkName(appName)]);
  return `if docker network inspect ${network} >/dev/null 2>&1; then docker network rm ${network} >/dev/null; fi`;
}

/**
 * The path the backend serves the store's UI and query API at: the
 * Service's traces resource (`/traces/:serviceId`, beside its setting), then
 * `ui`. `TracesController`'s proxy route is this path's template.
 */
export const traceStoreProxyPath = (serviceId: string): string =>
  `/traces/${serviceId}/ui`;

/**
 * Where the store's UI is served from, **as the browser sees it**: the
 * console's `/backend` rewrite in front of {@link traceStoreProxyPath}. Jaeger
 * writes its `base_path` into every asset link and API call the UI makes, so
 * it has to be the path the browser requests, not the one the backend
 * receives. The one source for both the store's config and the path the proxy
 * forwards to; the store reads it only when it (re)starts.
 */
export const traceStoreBasePath = (serviceId: string): string =>
  `${CONSOLE_BACKEND_PREFIX}${traceStoreProxyPath(serviceId)}`;

/** A `basicauth` header value, as the store checks it. */
export const basicAuthorization = (user: string, password: string): string =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

/**
 * What a deploy merges into a traced Service's container environment:
 * where to send spans, and the credential to send them with. Never written as
 * env rows.
 *
 * - The endpoint is the store's container name on `cloudgate-network`, which
 *   every Service is on, over OTLP/HTTP.
 * - The protocol is named, because the store's one receiver is OTLP/HTTP and
 *   the OpenTelemetry spec lets an SDK default to gRPC (Python's and older
 *   Java's do): without it such a Service would send nothing. It replaces an
 *   env row of the same name, like the other two.
 * - The header value is percent-encoded, because the OpenTelemetry spec reads
 *   `OTEL_EXPORTER_OTLP_HEADERS` in the W3C Baggage format and decodes each
 *   value: the space after `Basic` and base64's `+`, `/` and `=` would not
 *   survive otherwise.
 */
export const traceWiringEnv = (
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName'>,
  credential: string,
): Record<string, string> => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: `http://${traceStoreContainerName(owner)}:${TRACE_STORE_OTLP_HTTP_PORT}`,
  OTEL_EXPORTER_OTLP_HEADERS: otlpHeaders(credential),
  OTEL_EXPORTER_OTLP_PROTOCOL: TRACE_OTLP_PROTOCOL,
});

/** `OTEL_EXPORTER_OTLP_HEADERS`' value for this ingest credential. */
export const otlpHeaders = (credential: string): string =>
  `Authorization=${encodeURIComponent(
    basicAuthorization(TRACE_CREDENTIAL_USER, credential),
  )}`;

/** The variable {@link traceWiringEnv} puts the ingest credential in. */
export const OTLP_HEADERS_VARIABLE = 'OTEL_EXPORTER_OTLP_HEADERS';

/**
 * A container's `KEY=value` environment with {@link OTLP_HEADERS_VARIABLE}'s
 * value replaced by `<redacted>`, for a route that answers a container's
 * inspect (the credential never appears in any response). By the key,
 * not by matching the credential: the route has no row to hand, and a header
 * list an operator set on an untraced Service is a credential of theirs too.
 */
export function withoutOtlpHeaders(env: readonly string[]): string[] {
  const prefix = `${OTLP_HEADERS_VARIABLE}=`;
  return env.map((entry) =>
    entry.startsWith(prefix) ? `${prefix}<redacted>` : entry,
  );
}

/** Where the store's directory is mounted inside its container. */
const STORE_MOUNT = '/trace-store';

/**
 * The store's Jaeger v2 config.
 *
 * - **One receiver, OTLP/HTTP**, behind `basicauth/otlp` with the Service's
 *   credential, so one Service cannot write into another's store.
 * - **The UI and query API behind `basicauth/query`**, with the credential
 *   only the backend holds (`trace_store.query_credential` says why), and the
 *   gRPC query API on the container's loopback only.
 * - **Badger with `ttl.spans`** from retention; it applies to spans written
 *   after it is set, which is Badger's rule, not ours.
 * - **`memory_limiter` on the Go heap**, well under the container limit,
 *   because Badger's memory-mapped files are outside the heap.
 * - **No `otlp_proxy` and no `ai`**: both are `jaeger_query` options that
 *   accept writes or tool calls on the UI's port, which the backend proxies.
 * - Its own metrics and traces are off; nothing scrapes or receives them.
 *   Left on, its traces go to `localhost:4317`, where nothing listens, and
 *   every failed export is a log line (seen on a real store).
 */
export function traceStoreConfig(
  store: Pick<
    TraceStoreRuntime,
    'serviceId' | 'retentionDays' | 'credential' | 'queryCredential'
  >,
): string {
  const yamlString = (value: string) => JSON.stringify(value);
  return [
    'service:',
    '  extensions: [basicauth/otlp, basicauth/query, jaeger_storage, jaeger_query]',
    '  pipelines:',
    '    traces:',
    '      receivers: [otlp]',
    '      processors: [memory_limiter, batch]',
    '      exporters: [jaeger_storage_exporter]',
    '  telemetry:',
    '    metrics:',
    '      level: none',
    '    traces:',
    '      level: none',
    '    logs:',
    '      level: info',
    'extensions:',
    '  basicauth/otlp:',
    '    htpasswd:',
    `      inline: ${yamlString(`${TRACE_CREDENTIAL_USER}:${store.credential}`)}`,
    '  basicauth/query:',
    '    htpasswd:',
    `      inline: ${yamlString(`${TRACE_QUERY_USER}:${store.queryCredential}`)}`,
    '  jaeger_storage:',
    '    backends:',
    '      trace_store:',
    '        badger:',
    '          directories:',
    `            keys: ${STORE_MOUNT}/data/keys`,
    `            values: ${STORE_MOUNT}/data/values`,
    '          ephemeral: false',
    '          ttl:',
    `            spans: ${store.retentionDays * 24}h`,
    '  jaeger_query:',
    '    storage:',
    '      traces: trace_store',
    `    base_path: ${yamlString(traceStoreBasePath(store.serviceId))}`,
    '    http:',
    `      endpoint: 0.0.0.0:${TRACE_STORE_UI_PORT}`,
    '      auth:',
    '        authenticator: basicauth/query',
    '    grpc:',
    '      endpoint: 127.0.0.1:16685',
    'receivers:',
    '  otlp:',
    '    protocols:',
    '      http:',
    `        endpoint: 0.0.0.0:${TRACE_STORE_OTLP_HTTP_PORT}`,
    '        auth:',
    '          authenticator: basicauth/otlp',
    'processors:',
    '  memory_limiter:',
    '    check_interval: 1s',
    `    limit_mib: ${TRACE_STORE_MEMORY_LIMITER_MIB}`,
    `    spike_limit_mib: ${TRACE_STORE_MEMORY_SPIKE_MIB}`,
    '  batch: {}',
    'exporters:',
    '  jaeger_storage_exporter:',
    '    trace_storage: trace_store',
    '',
  ].join('\n');
}

/**
 * The environment variable the start and restart programs read the config
 * from. The config carries both credentials, so it travels in the program's
 * environment and never in its text, which is `ps`-readable.
 */
export const TRACE_STORE_CONFIG_VARIABLE = 'CG_TRACE_STORE_CONFIG';

/**
 * The shell lines that write the config file from the variable: the store's
 * directory closed first (`common/files/owner-only.ts`), then the file made
 * `0600` before a byte reaches it. Not `writeOwnerOnlyFileCommand`, whose
 * payload is in the program's text, which is where the credentials may not be.
 */
function writeConfigLines(directory: string): string[] {
  const file = quote([`${directory}/config.yaml`]);
  return [
    ownerOnlyDirectoryCommand(directory),
    `mkdir -p ${quote([`${directory}/data`])}`,
    `touch ${file}`,
    `chmod 600 ${file}`,
    `printf '%s' "$${TRACE_STORE_CONFIG_VARIABLE}" > ${file}`,
  ];
}

/**
 * The `docker run` that starts a store. A plain container, not a Swarm
 * service: it is not a Service and has no owner labels, so no Service route
 * resolves it (ADR-0028).
 *
 * - `--memory` and `--memory-swap` equal: a fixed limit with no swap past it.
 * - `--user` is the account that made the directory, so Badger can write to
 *   it whatever the image's default user is.
 * - The UI port is published on **loopback only**, on an ephemeral port the
 *   backend reads with `docker port`; nothing is on the public edge.
 * - `--restart unless-stopped`, so a Server reboot brings the store back and a
 *   Stop of the Service, which never touches it, leaves it running.
 */
function dockerRunCommand(
  store: Pick<TraceStoreRuntime, 'serviceType' | 'appName'>,
  directory: string,
): string {
  const logOptions = Object.entries(containerLogOptions()).flatMap(
    ([key, value]) => ['--log-opt', `${key}=${value}`],
  );
  const words = [
    'docker',
    'run',
    '--detach',
    '--name',
    traceStoreContainerName(store),
    '--restart',
    'unless-stopped',
    '--memory',
    `${TRACE_STORE_MEMORY_LIMIT_MIB}m`,
    '--memory-swap',
    `${TRACE_STORE_MEMORY_LIMIT_MIB}m`,
    '--network',
    traceStoreNetworkOf(store),
    '--publish',
    `127.0.0.1::${TRACE_STORE_UI_PORT}`,
    '--volume',
    `${directory}:${STORE_MOUNT}`,
    '--log-driver',
    CONTAINER_LOG_DRIVER,
    ...logOptions,
  ];
  // `$(id -u):$(id -g)` is the one word left unquoted: it is the substitution.
  return `${quote(words.slice(0, 3))} --user "$(id -u):$(id -g)" ${quote(
    words.slice(3),
  )} ${quote([TRACE_STORE_IMAGE, '--config', `${STORE_MOUNT}/config.yaml`])}`;
}

/** Runs a store program on its Server with the config in its environment. */
async function runWithConfig(
  remoteExec: RemoteExecService,
  store: TraceStoreRuntime,
  program: string,
): Promise<void> {
  const env = { [TRACE_STORE_CONFIG_VARIABLE]: traceStoreConfig(store) };
  if (store.serverId) {
    await remoteExec.execAsyncRemote(store.serverId, program, undefined, {
      env,
    });
  } else {
    await remoteExec.execAsync(program, { env: { ...process.env, ...env } });
  }
}

/** Whether the store's container is running on its Server now. */
export async function isTraceStoreRunning(
  remoteExec: RemoteExecService,
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>,
): Promise<boolean> {
  try {
    const stdout = await execOnServerStdout(remoteExec, owner.serverId, [
      'docker',
      'container',
      'inspect',
      '--format',
      '{{.State.Running}}',
      traceStoreContainerName(owner),
    ]);
    return stdout.trim() === 'true';
  } catch {
    // No such container, which is the common answer before a first deploy.
    return false;
  }
}

/**
 * Starts the store: writes its config, removes any stopped container of the
 * same name, and runs a new one over the same directory, so what Badger kept
 * is kept.
 */
export async function startTraceStore(
  remoteExec: RemoteExecService,
  store: TraceStoreRuntime,
): Promise<void> {
  const directory = traceStoreDirectoryOn(store);
  const program = [
    'set -e',
    ...writeConfigLines(directory),
    `docker rm --force ${quote([traceStoreContainerName(store)])} >/dev/null 2>&1 || true`,
    ...(store.serviceType === 'compose'
      ? [ensureTraceStoreNetworkCommand(store.appName)]
      : []),
    dockerRunCommand(store, directory),
  ].join('\n');
  await runWithConfig(remoteExec, store, program);
}

/**
 * Makes sure the store is running, which a deploy of a traced Service does
 * before the Service starts. Idempotent: a running store is left alone
 * and answers `'running'`.
 */
export async function ensureTraceStoreRunning(
  remoteExec: RemoteExecService,
  store: TraceStoreRuntime,
): Promise<'running' | 'started'> {
  if (await isTraceStoreRunning(remoteExec, store)) return 'running';
  await startTraceStore(remoteExec, store);
  return 'started';
}

/**
 * Restarts a running store in place with its config rewritten — a retention
 * change. Its directory is kept, so its traces are; the new `ttl.spans`
 * applies to spans written after it. A store that is not running is left for
 * the next deploy to start with the new config. Answers whether it restarted.
 */
export async function restartTraceStoreIfRunning(
  remoteExec: RemoteExecService,
  store: TraceStoreRuntime,
): Promise<boolean> {
  if (!(await isTraceStoreRunning(remoteExec, store))) return false;
  const program = [
    'set -e',
    ...writeConfigLines(traceStoreDirectoryOn(store)),
    `docker restart ${quote([traceStoreContainerName(store)])} >/dev/null`,
  ].join('\n');
  await runWithConfig(remoteExec, store, program);
  return true;
}

/**
 * The store's removal as two teardown steps, each naming what it left if it
 * fails: the container (by name, in `path`, as `network`'s entry does) and
 * then its directory. Both are idempotent — `docker rm --force` exits 0 for a
 * container that is not there, `rm -rf` for a path that is not — so a Service
 * that never deployed reports nothing.
 */
export function removeTraceStoreSteps(
  remoteExec: RemoteExecService,
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>,
): TeardownStep[] {
  const container = traceStoreContainerName(owner);
  const directory = traceStoreDirectoryOn(owner);
  const leftBehind = (path: string): UnreclaimedArtifact => ({
    kind: 'trace-store',
    appName: owner.appName,
    serverId: owner.serverId,
    path,
  });
  return [
    {
      run: () =>
        execOnServer(remoteExec, owner.serverId, [
          'docker',
          'rm',
          '--force',
          container,
        ]),
      leftBehindOnFailure: leftBehind(container),
    },
    {
      run: () =>
        execOnServer(remoteExec, owner.serverId, ['rm', '-rf', directory]),
      leftBehindOnFailure: leftBehind(directory),
    },
  ];
}

/** Removes the store's container and directory; answers what it could not. */
export function removeTraceStore(
  remoteExec: RemoteExecService,
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>,
): Promise<UnreclaimedArtifact[]> {
  return runTeardownSteps(removeTraceStoreSteps(remoteExec, owner));
}

/**
 * Which of these Services have a `trace_store` row — the Services whose store
 * a Delete has to reclaim. One select for all of them, on
 * `listCascadeChildren`'s reasoning; read before the Service's own statement
 * destroys the rows, since `trace_store`'s owner columns cascade.
 *
 * **A row, not `enabled`.** A turn-off whose removal failed leaves its row off
 * and its store behind, and a Delete is the next chance to reclaim it. A
 * Service whose traces were never touched has no row, never had a store, and
 * is asked nothing — which is why this is gated at all, unlike the
 * file-mounts tree every Application may have.
 */
export async function tracedServiceIdsOf(
  db: Pick<DrizzleDB, 'select'>,
  services: readonly { serviceType: string; serviceId: string }[],
): Promise<Set<string>> {
  const ids = services
    .filter((service) => isTraceServiceType(service.serviceType))
    .map((service) => service.serviceId);
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({
      applicationId: traceStore.applicationId,
      composeId: traceStore.composeId,
    })
    .from(traceStore)
    .where(
      or(
        inArray(traceStore.applicationId, ids),
        inArray(traceStore.composeId, ids),
      ),
    );
  return new Set(
    rows.map((row) => (row.applicationId ?? row.composeId) as string),
  );
}

/**
 * Removes these Services' Trace stores, each on its run Server (ADR-0018),
 * and answers with what could not be. The caller has already decided which
 * Services have one ({@link tracedServiceIdsOf}).
 *
 * In ADR-0016's post-refusal slot of both Deletes rather than their `teardown`
 * array: nothing regenerates a trace, so removing the store ahead of a 409
 * would erase the traces of a Service the caller is then told still exists.
 */
export async function removeTraceStores(
  remoteExec: RemoteExecService,
  owners: readonly Pick<
    TraceStoreOwner,
    'serviceType' | 'appName' | 'serverId'
  >[],
): Promise<UnreclaimedArtifact[]> {
  const unreclaimed: UnreclaimedArtifact[] = [];
  for (const owner of owners) {
    unreclaimed.push(...(await removeTraceStore(remoteExec, owner)));
    if (owner.serviceType === 'compose') {
      unreclaimed.push(...(await reclaimTraceStoreNetwork(remoteExec, owner)));
    }
  }
  return unreclaimed;
}

/**
 * Removes a Compose's store network, on a Delete only. A turn-off leaves
 * it: the Compose's services are still on it until its next deploy, so the
 * removal would be refused, and a later turn-on uses it again. By a Delete,
 * the Compose's workload is gone — this runs in the same post-refusal slot as
 * `reclaimComposeNetwork`, after the stack's tasks have left.
 */
function reclaimTraceStoreNetwork(
  remoteExec: RemoteExecService,
  owner: Pick<TraceStoreOwner, 'appName' | 'serverId'>,
): Promise<UnreclaimedArtifact[]> {
  return runTeardownSteps([
    {
      run: () =>
        execOnServer(
          remoteExec,
          owner.serverId,
          traceStoreNetworkReclaimCommand(owner.appName),
        ),
      leftBehindOnFailure: {
        kind: 'network',
        appName: owner.appName,
        serverId: owner.serverId,
        path: traceStoreNetworkName(owner.appName),
      },
    },
  ]);
}

/**
 * {@link tracedServiceIdsOf} then {@link removeTraceStores}, for a Delete of
 * the Services themselves (`ApplicationsService.remove`).
 */
export async function reclaimTraceStores(
  db: Pick<DrizzleDB, 'select'>,
  remoteExec: RemoteExecService,
  owners: readonly TraceStoreOwner[],
): Promise<UnreclaimedArtifact[]> {
  const traced = await tracedServiceIdsOf(db, owners);
  return removeTraceStores(
    remoteExec,
    owners.filter((owner) => traced.has(owner.serviceId)),
  );
}

/** The Service's `trace_store` row, or null when traces were never set up. */
export async function traceStoreRowOf(
  db: Pick<DrizzleDB, 'select'>,
  serviceType: TraceServiceType,
  serviceId: string,
): Promise<TraceStore | null> {
  const column = traceStoreOwnerColumn(serviceType);
  const [row] = await db
    .select()
    .from(traceStore)
    .where(eq(column, serviceId))
    .limit(1);
  return row ?? null;
}

/** A traced Service's deploy wiring: its store, and the env it is handed. */
export interface TraceWiring {
  store: TraceStoreRuntime;
  env: Record<string, string>;
}

/**
 * What a deploy of this Service injects, or null when its traces are off.
 * The engine and a Rollback both ask; a preview never does.
 */
export async function traceWiringFor(
  db: Pick<DrizzleDB, 'select'>,
  owner: TraceStoreOwner,
): Promise<TraceWiring | null> {
  const row = await traceStoreRowOf(db, owner.serviceType, owner.serviceId);
  if (!row?.enabled) return null;
  return {
    store: runtimeOf(owner, row),
    env: traceWiringEnv(owner, row.credential),
  };
}

/** Where {@link ensureTraceWiring} says what it did: a Deployment's log, or the backend's. */
export interface TraceWiringLog {
  info(line: string): Promise<void> | void;
  warn(line: string): Promise<void> | void;
}

/**
 * A traced Service's wiring, with its Trace store made sure of first; null
 * when its traces are off. What a deploy of either kind and a Rollback each do
 * before the Service starts, in one place so they cannot drift.
 *
 * **Neither a store that will not start nor a setting that cannot be read
 * fails the caller.** Traces are an observation of the Service, not part of
 * it: the Service starts anyway, `log.warn` says the store could not be started
 * and that the next deploy tries again, and the variables are still injected —
 * an OpenTelemetry SDK whose endpoint does not answer drops its spans and
 * carries on, and the Service's environment stays what the setting says it is
 * rather than what one attempt managed. A setting that cannot be read injects
 * nothing, since there is nothing to inject.
 */
export async function ensureTraceWiring(
  db: Pick<DrizzleDB, 'select'>,
  remoteExec: RemoteExecService,
  owner: TraceStoreOwner,
  log: TraceWiringLog,
): Promise<TraceWiring | null> {
  let wiring: TraceWiring | null;
  try {
    wiring = await traceWiringFor(db, owner);
  } catch (error) {
    // The host line's rule: a read that fails is said, not thrown.
    await log.warn(
      `⚠️ [Traces] The traces setting could not be read, so the Service starts with no OTEL_* variables: ${errorText(error)}`,
    );
    return null;
  }
  if (!wiring) return null;
  const name = traceStoreContainerName(owner);
  try {
    const state = await ensureTraceStoreRunning(remoteExec, wiring.store);
    await log.info(
      state === 'started'
        ? `🔭 [Traces] Started the Trace store '${name}'`
        : `🔭 [Traces] The Trace store '${name}' is running`,
    );
  } catch (error) {
    await log.warn(
      `⚠️ [Traces] The Trace store '${name}' could not be started, so no traces are kept until the next deploy starts it: ${errorText(error)}`,
    );
  }
  return wiring;
}

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The runtime a store is started from, off its owner and its row. */
export const runtimeOf = (
  owner: TraceStoreOwner,
  row: Pick<TraceStore, 'retentionDays' | 'credential' | 'queryCredential'>,
): TraceStoreRuntime => ({
  ...owner,
  retentionDays: row.retentionDays,
  credential: row.credential,
  queryCredential: row.queryCredential,
});

/** The store's UI port on its Server's loopback, as `docker port` reads it. */
export interface TraceStoreUiAddress {
  host: string;
  port: number;
}

/**
 * The command that reads where the store's UI port is published, as argv:
 * `docker port <name> 16686` on the store's Server. The start
 * publishes it on an ephemeral **loopback** port (`127.0.0.1::16686`), which a
 * restart can change, so it is read per request rather than stored. On the
 * platform host it runs through `RemoteExecService`
 * ({@link traceStoreUiAddress}); on a remote Server the proxy runs it over the
 * pooled SSH connection its channel then takes (`SshForwardService`).
 */
export const traceStoreUiAddressCommand = (
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName'>,
): string[] => [
  'docker',
  'port',
  traceStoreContainerName(owner),
  String(TRACE_STORE_UI_PORT),
];

/**
 * Where the store's UI port is published, read through `RemoteExecService`
 * on the store's Server. Null when the store is not running: the container is
 * absent or stopped, so `docker port` fails or prints nothing.
 */
export async function traceStoreUiAddress(
  remoteExec: RemoteExecService,
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>,
): Promise<TraceStoreUiAddress | null> {
  let stdout: string;
  try {
    stdout = await execOnServerStdout(
      remoteExec,
      owner.serverId,
      traceStoreUiAddressCommand(owner),
    );
  } catch {
    return null;
  }
  return parseTraceStoreUiAddress(owner, stdout);
}

/**
 * What {@link traceStoreUiAddressCommand} printed, read: the loopback port, or
 * null when it printed nothing. Anything but a loopback address is refused
 * rather than dialled: the proxy never reaches a store through a Server's
 * edge, whatever published it there. The refusal names the addresses, for the
 * log; it is never answered to a caller.
 */
export function parseTraceStoreUiAddress(
  owner: Pick<TraceStoreOwner, 'appName'>,
  stdout: string,
): TraceStoreUiAddress | null {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  for (const line of lines) {
    const published = /^127\.0\.0\.1:(\d{1,5})$/.exec(line);
    if (published) return { host: '127.0.0.1', port: Number(published[1]) };
  }
  throw new Error(
    `The Trace store of ${owner.appName} publishes its UI port somewhere other than loopback (${lines.join(', ')}); refusing to reach it there`,
  );
}

/**
 * The store directory's size on disk, in bytes, read on demand on the store's
 * Server: `du -sk`, argv. Allocated blocks rather than `du -sb`'s
 * apparent size, because Badger preallocates its value log sparse and the
 * apparent size would report space a new store does not use (and `-b` is
 * GNU-only). Null when there is no directory yet, which is a store that has
 * never started, or when it cannot be read.
 */
export async function traceStoreSizeBytes(
  remoteExec: RemoteExecService,
  owner: Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>,
): Promise<number | null> {
  try {
    const stdout = await execOnServerStdout(remoteExec, owner.serverId, [
      'du',
      '-sk',
      traceStoreDirectoryOn(owner),
    ]);
    const kib = /^(\d+)\s/.exec(stdout.trimStart());
    return kib ? Number(kib[1]) * 1024 : null;
  } catch {
    return null;
  }
}
