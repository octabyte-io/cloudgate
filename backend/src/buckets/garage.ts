import { randomBytes } from 'node:crypto';
import type { CreateServiceOptions } from 'dockerode';
import { quote } from 'shell-quote';
import { buildDatabaseServiceSpec } from '../databases/common/database-spec';
import type { DatabaseSpecSource } from '../databases/common/database-spec';
import { findRunningTask } from '../ai-models/model-readiness';
import type { LabelsSwarm } from '../applications/swarm.types';
import type { BucketAdminCredential } from './bucket.schema';
import {
  BUCKET_CORS_EXPOSED_HEADERS,
  BUCKET_CORS_METHODS,
} from './bucket-origins';

// A bucket on a Server, as Garage (ADR-0037): the image, its config, its
// Swarm service spec and the `garage` CLI programs that make the bucket and
// its key. Pure, so every word that reaches a Server is tested without one.

/**
 * The image every bucket on a Server runs, pinned by Cloudgate (ADR-0037),
 * so a bucket made today and one made next month read the same config and
 * keep their files in the same on-disk format. Garage's image is a single
 * static binary on `scratch`: there is no shell in it, which is why its
 * config arrives as a Swarm secret and every CLI call is `docker exec … /garage`.
 */
export const GARAGE_IMAGE = 'dxflrs/garage:v2.1.0';

/**
 * The one region Cloudgate starts Garage with (ADR-0037): what most SDKs
 * assume when nothing is set.
 */
export const GARAGE_REGION = 'us-east-1';

/** Garage's S3 API, the port a Service reaches the bucket at. */
export const GARAGE_S3_PORT = 3900;
const GARAGE_RPC_PORT = 3901;
const GARAGE_ADMIN_PORT = 3903;

/** Where the bucket's volume is mounted: Garage's metadata and its files. */
export const GARAGE_DATA_PATH = '/var/lib/garage';

/** Where Garage, and its CLI inside the container, read the config by default. */
const GARAGE_CONFIG_PATH = '/etc/garage.toml';

/**
 * The capacity the single node is given in the layout. With one node and a
 * replication factor of one, Garage uses it only to split partitions among
 * nodes, so the number caps nothing: the volume's disk is the limit.
 */
const SINGLE_NODE_CAPACITY = '1G';

/** A new admin credential, made with the bucket and never shown. */
export function newAdminCredential(): BucketAdminCredential {
  return {
    // Garage's RPC secret is 32 bytes, written as hex.
    rpcSecret: randomBytes(32).toString('hex'),
    adminToken: randomBytes(32).toString('base64url'),
  };
}

/** The data volume of the bucket whose Swarm service is `appName`. */
export const bucketVolumeName = (appName: string): string => `${appName}-data`;

/** The Swarm secret its config is handed over in, one per bucket. */
export const garageConfigSecretName = (appName: string): string =>
  `${appName}-garage-config`;

/**
 * `garage.toml` for one bucket's single node. Every value is Cloudgate's:
 * the two secrets are hex and URL-safe base64, so they sit in a TOML string
 * unescaped. No web endpoint, no root domain: a bucket is reached with its
 * key at the S3 API, path-style. It listens on IPv4's any address, not
 * `[::]`: Garage panics at start ("Address family not supported by
 * protocol") on a Server whose kernel has IPv6 turned off, and the Swarm
 * overlay it is reached over is IPv4.
 */
export function garageToml(credential: BucketAdminCredential): string {
  return [
    `metadata_dir = "${GARAGE_DATA_PATH}/meta"`,
    `data_dir = "${GARAGE_DATA_PATH}/data"`,
    'db_engine = "sqlite"',
    'replication_factor = 1',
    `rpc_bind_addr = "0.0.0.0:${GARAGE_RPC_PORT}"`,
    `rpc_public_addr = "127.0.0.1:${GARAGE_RPC_PORT}"`,
    `rpc_secret = "${credential.rpcSecret}"`,
    '',
    '[s3_api]',
    `s3_region = "${GARAGE_REGION}"`,
    `api_bind_addr = "0.0.0.0:${GARAGE_S3_PORT}"`,
    '',
    '[admin]',
    `api_bind_addr = "0.0.0.0:${GARAGE_ADMIN_PORT}"`,
    `admin_token = "${credential.adminToken}"`,
    '',
  ].join('\n');
}

/**
 * The Swarm service of one bucket: Garage on its run Server, its volume at
 * {@link GARAGE_DATA_PATH}, its config the secret `secretId` names. Built by
 * the database spec, since a bucket is deployed as a `postgres` entry is
 * (ADR-0037): one replica, stop-first, no published port, kept on a manager
 * because it has a volume. A bucket has no size, so no caps.
 */
export function garageServiceSpec(
  found: GarageServiceSource,
  secret: { secretId: string; secretName: string },
): CreateServiceOptions {
  const spec = buildDatabaseServiceSpec(garageSpecSource(found), {
    env: [],
    targetPort: GARAGE_S3_PORT,
  });
  const task = spec.TaskTemplate as NonNullable<
    CreateServiceOptions['TaskTemplate']
  > & { ContainerSpec?: Record<string, unknown> };
  return {
    ...spec,
    TaskTemplate: {
      ...task,
      ContainerSpec: {
        ...task.ContainerSpec,
        Secrets: [
          {
            SecretID: secret.secretId,
            SecretName: secret.secretName,
            File: {
              Name: GARAGE_CONFIG_PATH,
              UID: '0',
              GID: '0',
              Mode: 0o400,
            },
          },
        ],
      },
    },
  };
}

/** What a bucket's Swarm service is built from. */
export interface GarageServiceSource {
  readonly appName: string;
  readonly volumeName: string;
  readonly serverId: string | null;
  /** Its labels, the one Swarm setting its `native.docker` takes. */
  readonly labelsSwarm: LabelsSwarm | null;
}

/**
 * The bucket as the database spec and Swarm's convergence read it: its
 * labels, and every other override Cloudgate's default, one
 * replica, its volume. The labels go through the database spec's Docker
 * lock list as a database's do, so a stored `traefik.*`, `com.docker.*` or
 * `io.cloudgate.*` label fails its deploy naming it.
 */
export function garageSpecSource(
  found: GarageServiceSource,
): DatabaseSpecSource {
  return {
    appName: found.appName,
    dockerImage: GARAGE_IMAGE,
    command: null,
    args: null,
    externalPort: null,
    serverId: found.serverId,
    memoryLimit: null,
    memoryReservation: null,
    cpuLimit: null,
    cpuReservation: null,
    healthCheckSwarm: null,
    restartPolicySwarm: null,
    placementSwarm: null,
    updateConfigSwarm: null,
    rollbackConfigSwarm: null,
    modeSwarm: null,
    labelsSwarm: found.labelsSwarm,
    replicas: 1,
    mounts: [
      {
        type: 'volume',
        volumeName: found.volumeName,
        mountPath: GARAGE_DATA_PATH,
      },
    ],
    networkSwarm: null,
    stopGracePeriodSwarm: null,
    endpointSpecSwarm: null,
    ulimitsSwarm: null,
    ports: [],
  };
}

/** How long the program waits for Garage to answer once its task runs. */
const GARAGE_READY_ATTEMPTS = 30;

/** The program's opening: Garage's running task, and a `garage` that runs in it. */
function garageIn(appName: string, doWhat: string): string[] {
  return [
    'set -e',
    ...findRunningTask(appName, doWhat),
    'garage() { docker exec "$CONTAINER_ID" /garage "$@"; }',
    `i=0; until garage status >/dev/null 2>&1; do i=$((i+1)); if [ "$i" -ge ${GARAGE_READY_ATTEMPTS} ]; then echo ${quote([`Garage in ${appName} did not answer`])} >&2; exit 1; fi; sleep 1; done`,
  ];
}

/**
 * The program that makes the bucket, run on its run Server once its task is
 * running: the single node's layout, then the bucket. A bucket that exists
 * is left as it is, so a redeploy changes nothing. A layout a previous
 * deploy already applied refuses `--version 1`, which is not a failure:
 * whether the node holds a role is what `bucket create` then answers.
 */
export function createBucketProgram(appName: string, name: string): string {
  const bucket = quote([name]);
  return [
    ...garageIn(appName, 'make the bucket in'),
    `if ! garage bucket info ${bucket} >/dev/null 2>&1; then`,
    '  NODE=$(garage node id -q | cut -d@ -f1)',
    `  garage layout assign -z dc1 -c ${SINGLE_NODE_CAPACITY} "$NODE" >/dev/null`,
    '  garage layout apply --version 1 >/dev/null 2>&1 || true',
    `  garage bucket create ${bucket} >/dev/null`,
    'fi',
  ].join('\n');
}

/** The markers {@link createKeyProgram} prints the key between. */
const KEY_ID_MARKER = 'CLOUDGATE_KEY_ID=';
const SECRET_KEY_MARKER = 'CLOUDGATE_SECRET_KEY=';

/**
 * The program that makes the bucket's one key and grants it read and write
 * on that bucket only — never `--owner`, so it cannot change the bucket's
 * settings (ADR-0037). Garage makes the key, so its secret never travels in
 * any command: it comes back once, on this program's output, and is stored
 * encrypted from there (ADR-0006).
 */
export function createKeyProgram(
  appName: string,
  name: string,
  keyName: string,
): string {
  return [
    ...garageIn(appName, 'make the key in'),
    `OUT=$(garage key create ${quote([keyName])})`,
    `KEY_ID=$(printf '%s\\n' "$OUT" | sed -n 's/^Key ID: *//p' | head -n 1)`,
    `SECRET=$(printf '%s\\n' "$OUT" | sed -n 's/^Secret key: *//p' | head -n 1)`,
    'if [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; then echo "Garage did not say the new key\'s ID and secret" >&2; exit 1; fi',
    `garage bucket allow --read --write ${quote([name])} --key "$KEY_ID" >/dev/null`,
    `printf '%s%s\\n%s%s\\n' ${quote([KEY_ID_MARKER])} "$KEY_ID" ${quote([SECRET_KEY_MARKER])} "$SECRET"`,
  ].join('\n');
}

/** The key {@link createKeyProgram} printed, or `null` when it printed none. */
export function readCreatedKey(
  stdout: string,
): { accessKeyId: string; secretAccessKey: string } | null {
  const line = (marker: string) =>
    stdout
      .split('\n')
      .find((one) => one.startsWith(marker))
      ?.slice(marker.length)
      .trim() ?? '';
  const accessKeyId = line(KEY_ID_MARKER);
  const secretAccessKey = line(SECRET_KEY_MARKER);
  if (!accessKeyId || !secretAccessKey) return null;
  return { accessKeyId, secretAccessKey };
}

/** The marker {@link removeKeysProgram} prints each removed key after. */
const KEY_REMOVED_MARKER = 'CLOUDGATE_KEY_REMOVED=';

/**
 * The program that removes keys Cloudgate made for the bucket: a
 * rotated-out key once every linking Service holds the new one, or a new
 * key a failed rotation discards. Each removed on its own and reported as
 * `CLOUDGATE_KEY_REMOVED=<id>`, so one Garage refuses leaves the others
 * removed and is retried by the next rotation. A key Garage no longer has
 * counts as removed: what was asked is that it no longer opens the bucket.
 */
export function removeKeysProgram(
  appName: string,
  keyIds: readonly string[],
): string {
  return [
    ...garageIn(appName, 'remove keys in'),
    ...keyIds.map((keyId) => {
      const id = quote([keyId]);
      return `if garage key delete --yes ${id} >/dev/null 2>&1 || ! garage key info ${id} >/dev/null 2>&1; then printf '%s%s\\n' ${quote([KEY_REMOVED_MARKER])} ${id}; fi`;
    }),
  ].join('\n');
}

/** The key IDs {@link removeKeysProgram} reported removed. */
export function readRemovedKeys(stdout: string): string[] {
  return stdout
    .split('\n')
    .filter((line) => line.startsWith(KEY_REMOVED_MARKER))
    .map((line) => line.slice(KEY_REMOVED_MARKER.length).trim())
    .filter((id) => id.length > 0);
}

/**
 * The image the CORS request is sent from, pinned like Garage. It
 * runs in the network of Garage's own task, so it reaches the S3 API at
 * `127.0.0.1` with no port published; `curl --aws-sigv4` signs the request.
 */
export const CORS_CLIENT_IMAGE = 'curlimages/curl:8.11.1';

/**
 * The bucket's S3 CORS configuration for `origins`: one rule per origin.
 * Not one rule naming them all — Garage answers a matching preflight with
 * the rule's every origin joined in `Access-Control-Allow-Origin`, which a
 * browser refuses unless it is exactly its own. Each is a parsed browser
 * origin (`bucket-origins.ts`), which holds no character XML must escape.
 */
export function corsConfigurationXml(origins: readonly string[]): string {
  const rule = (origin: string) =>
    [
      '<CORSRule>',
      `<AllowedOrigin>${origin}</AllowedOrigin>`,
      ...BUCKET_CORS_METHODS.map(
        (method) => `<AllowedMethod>${method}</AllowedMethod>`,
      ),
      '<AllowedHeader>*</AllowedHeader>',
      ...BUCKET_CORS_EXPOSED_HEADERS.map(
        (header) => `<ExposeHeader>${header}</ExposeHeader>`,
      ),
      '</CORSRule>',
    ].join('');
  return `<CORSConfiguration>${origins.map(rule).join('')}</CORSConfiguration>`;
}

/**
 * The program that sets the bucket's CORS to `origins`, run on its
 * run Server through Cloudgate's admin access to the container — never
 * through the bucket's key, which is not owner and cannot.
 *
 * Garage takes CORS only through its S3 API (`PutBucketCors`, from a key
 * that owns the bucket): neither its CLI nor its admin API in the pinned
 * version sets it. So the program has the `garage` CLI make a key for this
 * one request, grant it owner on the bucket, send the request from
 * {@link CORS_CLIENT_IMAGE} in Garage's task network, and delete the key on
 * the way out, whether the request went through or not. Its secret stays in
 * the program: it reaches curl on stdin as its config, never on a command
 * line. An empty list deletes the bucket's CORS, so no origin is allowed.
 */
export function bucketCorsProgram(
  appName: string,
  name: string,
  origins: readonly string[],
): string {
  const url = `http://127.0.0.1:${GARAGE_S3_PORT}/${name}?cors`;
  const request =
    origins.length === 0
      ? ['-X', 'DELETE', url]
      : ['-X', 'PUT', '--data-binary', corsConfigurationXml(origins), url];
  return [
    ...garageIn(appName, 'set the CORS of'),
    `OUT=$(garage key create ${quote([`${appName}-cors`])})`,
    `KEY_ID=$(printf '%s\\n' "$OUT" | sed -n 's/^Key ID: *//p' | head -n 1)`,
    `SECRET=$(printf '%s\\n' "$OUT" | sed -n 's/^Secret key: *//p' | head -n 1)`,
    'if [ -z "$KEY_ID" ] || [ -z "$SECRET" ]; then echo "Garage did not say the new key\'s ID and secret" >&2; exit 1; fi',
    `trap 'garage key delete --yes "$KEY_ID" >/dev/null 2>&1 || true' EXIT`,
    `garage bucket allow --owner ${quote([name])} --key "$KEY_ID" >/dev/null`,
    `printf 'user = "%s:%s"\\n' "$KEY_ID" "$SECRET" | docker run --rm -i --network "container:$CONTAINER_ID" ${quote(
      [
        CORS_CLIENT_IMAGE,
        '-K',
        '-',
        '-fsS',
        '-o',
        '/dev/null',
        '--aws-sigv4',
        `aws:amz:${GARAGE_REGION}:s3`,
        ...request,
      ],
    )}`,
  ].join('\n');
}
