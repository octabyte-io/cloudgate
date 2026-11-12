import { isMap, parseDocument, Scalar } from 'yaml';

/**
 * Request metrics: Traefik's per-service request counters, which the backend
 * reads as a Service's **Error rate** (ADR-0027) — the one source for the
 * block every writer puts in `traefik.yml`.
 *
 * Four writers emit it: `deploy/install.sh`, `deploy/traefik/traefik.yml.example`
 * and `serverSetupCommand` as text, and **Enable request metrics**
 * (`TraefikFilesService.enableRequestMetrics`) as a `yaml` Document edit.
 * `common/config/` for `access-log-note.ts`'s reason: the provisioning script
 * and a Nest service both need it and neither should import the other. The two
 * shell copies are held to this by `test/servers/server-setup.spec.ts`.
 *
 * **Loopback is a tenant-isolation requirement, not a nicety.** On `:8082`
 * every container on the Traefik network could read every Service's counters
 * (measured). `127.0.0.1` inside the Traefik container is reachable only
 * from that container, which is exactly where the collector reads it from
 * (`docker exec cloudgate-traefik wget -qO- {@link REQUEST_METRICS_URL}`). It
 * never goes on the `traefik` entryPoint "Publish the dashboard" exposes.
 */
export const REQUEST_METRICS_ENTRYPOINT = 'metrics';

/** Where the entryPoint listens, inside the Traefik container. */
export const REQUEST_METRICS_ADDRESS = '127.0.0.1:8082';

/** What the collector fetches from inside the Traefik container. */
export const REQUEST_METRICS_URL = `http://${REQUEST_METRICS_ADDRESS}/metrics`;

/**
 * `metrics.prometheus`, exactly. Service labels are what the forward index
 * matches on; router labels are off because nothing reads them and each one is
 * another series per router.
 */
export const REQUEST_METRICS_PROMETHEUS = {
  entryPoint: REQUEST_METRICS_ENTRYPOINT,
  addServicesLabels: true,
  addRoutersLabels: false,
} as const;

const REQUEST_METRICS_LINES = [
  'Request metrics (ADR-0027): per-service request counters, read by the',
  "backend as each Service's Error rate. Loopback only — on any other address",
  "every container on the Traefik network could read every Service's counters.",
  'Never on the dashboard entryPoint.',
];

/** The note as `yaml`'s `commentBefore` takes it (the serialiser adds `#`). */
export const REQUEST_METRICS_NOTE = REQUEST_METRICS_LINES.map(
  (line) => ` ${line}`,
).join('\n');

/** The same note as literal YAML, for a writer that emits the file as text. */
export const REQUEST_METRICS_COMMENT = REQUEST_METRICS_LINES.map(
  (line) => `# ${line}`,
).join('\n');

/** The entryPoint, as the two lines it is under `entryPoints:` in text. */
export const REQUEST_METRICS_ENTRYPOINT_YAML = [
  `  ${REQUEST_METRICS_ENTRYPOINT}:`,
  `    address: '${REQUEST_METRICS_ADDRESS}'`,
].join('\n');

/** The top-level `metrics:` block with its note, as text. */
export const REQUEST_METRICS_BLOCK_YAML = [
  REQUEST_METRICS_COMMENT,
  'metrics:',
  '  prometheus:',
  `    entryPoint: ${REQUEST_METRICS_PROMETHEUS.entryPoint}`,
  `    addServicesLabels: ${REQUEST_METRICS_PROMETHEUS.addServicesLabels}`,
  `    addRoutersLabels: ${REQUEST_METRICS_PROMETHEUS.addRoutersLabels}`,
].join('\n');

interface MetricsShape {
  entryPoints?: Record<string, { address?: unknown } | null> | null;
  metrics?: { prometheus?: Record<string, unknown> | null } | null;
}

/**
 * Whether a `traefik.yml` carries request metrics as the writers write them:
 * the loopback entryPoint, and `metrics.prometheus` on it with service labels.
 * A block on any other address or entryPoint is **not** request metrics — it
 * is the thing loopback exists to prevent — so it reads as off. Unparseable
 * YAML reads as off too, rather than throwing out of a read.
 */
export function carriesRequestMetrics(traefikYaml: string): boolean {
  const doc = parseDocument(traefikYaml);
  if (doc.errors.length > 0) return false;
  const config = doc.toJS() as MetricsShape | null;
  const entryPoint = config?.entryPoints?.[REQUEST_METRICS_ENTRYPOINT];
  const prometheus = config?.metrics?.prometheus;
  return (
    entryPoint?.address === REQUEST_METRICS_ADDRESS &&
    prometheus?.entryPoint === REQUEST_METRICS_ENTRYPOINT &&
    prometheus?.addServicesLabels === true
  );
}

/**
 * `traefikYaml` with request metrics written in: the loopback entryPoint beside
 * the others, and `metrics.prometheus` replaced whole (so a prometheus block an
 * operator pointed at the dashboard entryPoint is moved off it). Everything
 * else — other entryPoints, other `metrics` backends, comments — is kept,
 * because it is a Document edit rather than parse/stringify. Idempotent.
 */
export function withRequestMetrics(traefikYaml: string): string {
  const doc = parseDocument(traefikYaml);
  doc.setIn(
    ['entryPoints', REQUEST_METRICS_ENTRYPOINT],
    doc.createNode({ address: REQUEST_METRICS_ADDRESS }),
  );
  const hadMetrics = doc.has('metrics');
  doc.setIn(
    ['metrics', 'prometheus'],
    doc.createNode({ ...REQUEST_METRICS_PROMETHEUS }),
  );
  if (!hadMetrics) {
    // The note goes on the pair's key, as `toggleRequests` puts its own: on the
    // value it renders underneath `metrics:` rather than above it.
    const contents: unknown = doc.contents;
    const pair = isMap(contents)
      ? contents.items.find((item) => String(item.key) === 'metrics')
      : undefined;
    if (pair) {
      const key = new Scalar('metrics');
      key.commentBefore = REQUEST_METRICS_NOTE;
      pair.key = key;
    }
  }
  return doc.toString();
}
