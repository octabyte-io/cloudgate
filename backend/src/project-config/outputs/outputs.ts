import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import type { PerCloud } from '../../cloud-accounts/cloud-provider';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';

/**
 * **Outputs** (ADR-0031, `CONTEXT.md`): what each kind hands out to a wired
 * variable, and the value of each. Pure, and target-blind on purpose: a
 * target reports only where the source is reached — host, port, whether TLS
 * is on and the CA bundle to trust — and the value is built here, so a URL
 * has one form on every target. Nothing here names a cloud provider but
 * {@link cloudTarget}, which says what each cloud's target leaves without a
 * value.
 *
 * A kind not in {@link OUTPUTS} hands out nothing: every Application kind
 * and every console-managed kind. A new kind
 * adds its list and its values here and nowhere else, as the bucket did
 * (ADR-0032).
 */

/** The Outputs each kind hands out, in the order they are listed to an operator. */
export const OUTPUTS = {
  postgres: ['url', 'host', 'port', 'user', 'password', 'database', 'ca'],
  // postgres's list, on every target.
  mysql: ['url', 'host', 'port', 'user', 'password', 'database', 'ca'],
  redis: ['url', 'host', 'port', 'password', 'ca'],
  // No default Output and no `url`; every one is a secret (ADR-0032).
  bucket: [
    'name',
    'region',
    'endpoint',
    'access_key_id',
    'secret_access_key',
    'path_style',
  ],
} as const satisfies Record<string, readonly string[]>;

export type OutputKind = keyof typeof OUTPUTS;

/** The Output that exists only where the target reports a CA bundle. */
const CA_OUTPUT = 'ca';

export function isOutputKind(kind: string): kind is OutputKind {
  return Object.hasOwn(OUTPUTS, kind);
}

/**
 * The Outputs a source of `kind` hands out on a target that does (`ca:
 * true`) or does not report a CA bundle. A Server reports none, so `ca` is
 * an unknown Output there, never an empty one. Empty for a kind that hands
 * out nothing.
 */
export function outputsOf(
  kind: string,
  target: { readonly ca: boolean },
): readonly string[] {
  if (!isOutputKind(kind)) return [];
  const names: readonly string[] = OUTPUTS[kind];
  return target.ca ? names : names.filter((name) => name !== CA_OUTPUT);
}

/** What a source's own saved settings give its Outputs. */
export type OutputSource =
  | {
      readonly kind: 'postgres' | 'mysql';
      readonly user: string;
      readonly password: string;
      readonly database: string;
    }
  | {
      readonly kind: 'redis';
      /**
       * `null` where it has none (ADR-0042): its `password` Output
       * has no value, and its `url` no userinfo.
       */
      readonly password: string | null;
    }
  | ({
      readonly kind: 'bucket';
      /** The real name, Cloudgate's, never the Config name. */
      readonly name: string;
      readonly region: string;
      /** Whether the store is addressed path-style rather than by subdomain. */
      readonly pathStyle: boolean;
    } & (
      | {
          /** The bucket's one key: read and write on it alone (ADR-0037). */
          readonly accessKeyId: string;
          readonly secretAccessKey: string;
        }
      | {
          /**
           * No key: the linking Service's own role gives access (ADR-0032), so
           * {@link ROLE_GIVEN}'s Outputs have no value.
           */
          readonly accessKeyId: null;
          readonly secretAccessKey: null;
        }
    ));

/**
 * The Outputs that have **no value** where the linking Service's own
 * identity gives it access (ADR-0032): a bucket's key, on a target
 * whose Services each run as their own role. A variable linked to one is
 * left unset, never set empty, so the app's SDK falls back to that role.
 */
const ROLE_GIVEN: { readonly [Kind in OutputKind]?: readonly string[] } = {
  bucket: ['access_key_id', 'secret_access_key'],
};

/**
 * The Outputs that have **no value** where a source is kept to its
 * Environment's own private network instead of a password (ADR-0042): a redis's
 * password, on a target that makes it with none. A
 * variable linked to one is left unset, never set empty.
 */
const NETWORK_GIVEN: { readonly [Kind in OutputKind]?: readonly string[] } = {
  redis: ['password'],
};

/** What a target leaves without a value. */
export interface OutputTarget {
  /** Each Service runs as its own role, which gives access (ADR-0032). */
  readonly ownRole: boolean;
  /** A redis has no password, its network alone keeping others out (ADR-0042). */
  readonly networkOnly?: boolean;
}

/**
 * A Cloud account's target: on AWS every Service runs as its own role,
 * which gives it access to a bucket it links (ADR-0032); on Google Cloud a
 * bucket is reached by its own key instead, as on a Server, since the S3 SDK
 * cannot use a Cloud Run service's identity, and a redis is on
 * Memorystore, made with no password (ADR-0042). The one place either
 * is said, for the plan and the deploy alike. An absent cloud is read by
 * `cloudOrLegacy`.
 */
export function cloudTarget(cloud: CloudKind | undefined): OutputTarget {
  return byCloud(cloudOrLegacy(cloud), CLOUD_TARGETS);
}

/**
 * Each cloud's target (ADR-0043): the Service's own role on AWS, a bucket's
 * own key and only a network for a redis on Google Cloud.
 */
const CLOUD_TARGETS: PerCloud<OutputTarget> = {
  aws: { ownRole: true, networkOnly: false },
  gcp: { ownRole: false, networkOnly: true },
};

/**
 * The Outputs of a `kind` source that have no value on `target`: its role
 * given ones where a Service runs as its own role, its network given ones
 * where the network alone keeps others out; none elsewhere.
 */
export function outputsWithoutValue(
  kind: string,
  target: OutputTarget,
): readonly string[] {
  if (!isOutputKind(kind)) return [];
  return [
    ...(target.ownRole ? (ROLE_GIVEN[kind] ?? []) : []),
    ...(target.networkOnly ? (NETWORK_GIVEN[kind] ?? []) : []),
  ];
}

/** Where a source is reached, as its target reports it. */
export interface SourceAddress {
  readonly host: string;
  readonly port: number;
  /** Whether the source takes only TLS connections. */
  readonly tls: boolean;
  /** The CA bundle a client must trust, where the target has one. */
  readonly ca: string | null;
}

/**
 * Every Output's value for one source at one address. Credentials in a URL
 * are percent-encoded, so a password with `@` or `/` still parses. With
 * TLS on, a postgres URL asks for it (`?sslmode=require`) and a redis URL
 * takes the `rediss` scheme with the token as its password; a mysql URL
 * never names TLS, since MySQL drivers spell it each their own way,
 * so one form works with all of them. A redis with
 * no password (ADR-0042) hands out no `password` value. A bucket's
 * endpoint is its store's S3 API at that address, `https` with TLS on, the
 * scheme's default port left out. A bucket with no key hands
 * out no `access_key_id` or `secret_access_key` value.
 */
export function outputValues(
  source: OutputSource,
  address: SourceAddress,
): Readonly<Record<string, string>> {
  const { host, port, tls, ca } = address;
  if (source.kind === 'bucket') {
    const defaultPort = tls ? 443 : 80;
    return {
      name: source.name,
      region: source.region,
      endpoint: `${tls ? 'https' : 'http'}://${host}${port === defaultPort ? '' : `:${port}`}`,
      // No key where the Service's own role gives access: no value at all.
      ...(source.accessKeyId === null
        ? {}
        : {
            access_key_id: source.accessKeyId,
            secret_access_key: source.secretAccessKey,
          }),
      path_style: String(source.pathStyle),
    };
  }
  const enc = encodeURIComponent;
  const common: Record<string, string> = { host, port: String(port) };
  if (source.password !== null) common.password = source.password;
  if (ca !== null) common.ca = ca;
  switch (source.kind) {
    case 'postgres':
      return {
        ...common,
        url: `postgresql://${enc(source.user)}:${enc(source.password)}@${host}:${port}/${enc(source.database)}${tls ? '?sslmode=require' : ''}`,
        user: source.user,
        database: source.database,
      };
    case 'mysql':
      return {
        ...common,
        url: `mysql://${enc(source.user)}:${enc(source.password)}@${host}:${port}/${enc(source.database)}`,
        user: source.user,
        database: source.database,
      };
    case 'redis': {
      // A cache with no password (an existing one with no AUTH token;
      // Memorystore, ADR-0042) has no userinfo. ElastiCache's AUTH token is
      // the `default` user's password, named as such: `valkey-cli -u` sends
      // no usable AUTH for an empty user, and the walk's `web` got
      // `WRONGPASS` from ElastiCache with one.
      const login =
        source.password === null || source.password === ''
          ? ''
          : `default:${enc(source.password)}@`;
      return {
        ...common,
        url: `${tls ? 'rediss' : 'redis'}://${login}${host}:${port}`,
      };
    }
  }
}

/**
 * Which Outputs each of a source's own settings feeds, named as the
 * {@link OutputSource} field it is: what a change of that setting changes,
 * so a plan redeploys, and a console edit marks, only the Services linking
 * to one of them. An address (`host`, `port`) is the target's, and a
 * re-created source changes every Output.
 */
const FED_BY: {
  readonly [Kind in OutputKind]: Readonly<
    Partial<Record<string, readonly string[]>>
  >;
} = {
  postgres: {
    user: ['url', 'user'],
    password: ['url', 'password'],
    database: ['url', 'database'],
  },
  mysql: {
    user: ['url', 'user'],
    password: ['url', 'password'],
    database: ['url', 'database'],
  },
  redis: { password: ['url', 'password'] },
  // A bucket's description changes none of its Outputs.
  bucket: {},
};

/** The Outputs a change of these `settings` of a `kind` source changes. */
export function outputsChangedBy(
  kind: string,
  settings: readonly string[],
): readonly string[] {
  if (!isOutputKind(kind)) return [];
  const fed: Partial<Record<string, readonly string[]>> = FED_BY[kind];
  const changed = new Set(settings.flatMap((setting) => fed[setting] ?? []));
  return OUTPUTS[kind].filter((name) => changed.has(name));
}

/**
 * The Outputs a source's address moving changes: an Existing
 * database a plan's lookup finds at another host or port. A host feeds
 * `url` and `host`, a port `url` and `port`; the same address changes none.
 */
export function outputsMovedBy(
  kind: string,
  from: { readonly host: string; readonly port: number },
  to: { readonly host: string; readonly port: number },
): readonly string[] {
  if (!isOutputKind(kind)) return [];
  const changed = new Set([
    ...(from.host === to.host ? [] : ['url', 'host']),
    ...(from.port === to.port ? [] : ['url', 'port']),
  ]);
  return OUTPUTS[kind].filter((name) => changed.has(name));
}
