import { RDS_ENGINES } from '../definitions/rds-engines';
import type { RdsEngineName } from '../definitions/rds-engines';
import { TAG_KEYS } from '../definitions/tags';
import type {
  TofuModule,
  TofuShowJson,
  TofuStateResource,
} from './tofu-show.types';

/** What the lookup of an Existing database found in AWS. */
export interface FoundPostgres {
  readonly identifier: string;
  readonly engine: string;
  readonly engineVersion: string | null;
  readonly host: string;
  readonly port: number;
  /** The VPC its DB subnet group is in, when AWS said. */
  readonly vpcId: string | null;
  readonly tags: Readonly<Record<string, string>>;
}

/**
 * The instance the lookup's plan read (`existing-postgres-lookup.ts`), or
 * `null` when its search found none. Read from the plan's refreshed state,
 * where OpenTofu puts every `data` source it read while planning.
 */
export function foundPostgres(show: TofuShowJson): FoundPostgres | null {
  const data = dataSourcesOf(show);
  const instance = data.find((one) => one.type === 'aws_db_instance')?.values;
  if (!instance) return null;
  const subnets = data.find(
    (one) => one.type === 'aws_db_subnet_group',
  )?.values;
  return {
    identifier: text(instance.db_instance_identifier) ?? '',
    engine: text(instance.engine) ?? '',
    engineVersion: text(instance.engine_version),
    host: text(instance.address) ?? '',
    port:
      Number(instance.port) ||
      RDS_ENGINES[instance.engine === 'mysql' ? 'mysql' : 'postgres'].port,
    vpcId: text(subnets?.vpc_id),
    tags: tagsOf(instance.tags),
  };
}

/**
 * Every `data` source a lookup's plan read, from the plan's
 * refreshed state, where OpenTofu puts each one it read while planning.
 */
export function dataSourcesOf(show: TofuShowJson): TofuStateResource[] {
  return [
    ...resourcesOf(show.prior_state?.values?.root_module),
    ...resourcesOf(show.planned_values?.root_module),
  ].filter((resource) => resource.mode === 'data');
}

/** A non-empty string value, else `null`. */
export function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** A data source's `tags`, as strings; none when it has none. */
export function tagsOf(value: unknown): Readonly<Record<string, string>> {
  return value && typeof value === 'object'
    ? Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, one]) => [
          key,
          String(one),
        ]),
      )
    : {};
}

function resourcesOf(module: TofuModule | undefined): TofuStateResource[] {
  if (!module) return [];
  return [
    ...(module.resources ?? []),
    ...(module.child_modules ?? []).flatMap(resourcesOf),
  ];
}

/** What a lookup is judged against: the Service, its place and its settings. */
export interface LookupContext {
  /**
   * The kind of the Service: a `postgres` uses only a PostgreSQL
   * instance, a `mysql` only a MySQL one.
   */
  readonly engine: RdsEngineName;
  /** The Service's Config name. */
  readonly serviceName: string;
  readonly identifier: string;
  /** The Cloud account as an operator knows it: its name and AWS account id. */
  readonly cloudAccount: string;
  readonly region: string;
  /** The Environment network's VPC there, or `null` while it is not made. */
  readonly networkVpcId: string | null;
  /** The "I made it reachable from this Environment" tick. */
  readonly madeReachable: boolean;
  /** The config's `version` when it states one (`postgres:17`), else `null`. */
  readonly configVersion: string | null;
}

export type LookupVerdict =
  | {
      readonly ok: false;
      readonly reason: string;
      /** AWS has nothing under the identifier: "AWS cannot find" it. */
      readonly missing?: true;
    }
  | {
      readonly ok: true;
      readonly address: { readonly host: string; readonly port: number };
      /** The plan's lines for it, notes included. */
      readonly lines: string[];
    };

/**
 * Whether an Existing database can be used as given (ADR-0033, the AWS databases spec
 * "Each plan's lookup"): refused when AWS has no such instance (naming the
 * identifier, the Cloud account and the region), when it does not run the
 * Service's engine (PostgreSQL for a `postgres`, MySQL for a `mysql`),
 * when it carries Cloudgate's tags (one Cloudgate made, for this or another
 * Environment), or when it sits outside the Environment network's VPC
 * without the operator's tick. With the tick, the plan says Cloudgate
 * cannot check it; a major version other than the config's is a note.
 */
export function judgeLookup(
  found: FoundPostgres | null,
  context: LookupContext,
): LookupVerdict {
  const { serviceName: name, identifier } = context;
  const { engine, label, majorOf: majorIn } = RDS_ENGINES[context.engine];
  const uses = `${name} uses the existing database ${identifier}`;
  if (!found) {
    return {
      ok: false,
      missing: true,
      reason: `${uses}, but AWS has no RDS instance ${identifier} in Cloud account ${context.cloudAccount}, region ${context.region}. Check the identifier on ${name}'s page; it must be in this Environment's Cloud account and region`,
    };
  }
  if (found.engine !== engine) {
    return {
      ok: false,
      reason: `${uses}, but ${identifier} runs ${found.engine || 'another engine'}, not ${label}, so a ${engine} cannot use it`,
    };
  }
  const tagged = cloudgateTagged(uses, identifier, found.tags);
  if (tagged) return { ok: false, reason: tagged };
  const lines = [
    `${name}: existing database ${identifier}${found.engineVersion ? `, ${label} ${found.engineVersion}` : ''}, at ${found.host}:${found.port}; used as given, Cloudgate changes nothing in it`,
  ];
  const reach = reachOf(context, found.vpcId);
  if (reach.refusal) return { ok: false, reason: reach.refusal };
  lines.push(...reach.lines);
  const wanted = majorIn(context.configVersion);
  const running = majorIn(found.engineVersion);
  if (wanted !== null && running !== null && wanted !== running) {
    lines.push(
      `${name}: ${identifier} runs ${label} ${found.engineVersion}, and the config's version is ${wanted}; the version is not applied to an existing database`,
    );
  }
  return {
    ok: true,
    address: { host: found.host, port: found.port },
    lines,
  };
}

/**
 * Why an existing database carrying Cloudgate's tags is refused (one
 * Cloudgate made, for this or another Environment), or `null`.
 */
export function cloudgateTagged(
  uses: string,
  identifier: string,
  tags: Readonly<Record<string, string>>,
): string | null {
  const ours = Object.keys(tags).filter((key) =>
    (Object.values(TAG_KEYS) as string[]).includes(key),
  );
  if (ours.length === 0) return null;
  return `${uses}, but ${identifier} carries Cloudgate's tags (${ours.sort().join(', ')}), so Cloudgate made it for an Environment; an existing database must be one Cloudgate did not make`;
}

/**
 * An existing database outside the Environment network's VPC: refused
 * without the operator's tick, and with it a line saying Cloudgate cannot
 * check it. Nothing to say inside the network.
 */
export function reachOf(
  context: Pick<
    LookupContext,
    'serviceName' | 'identifier' | 'networkVpcId' | 'madeReachable'
  >,
  vpcId: string | null,
): { readonly refusal: string | null; readonly lines: string[] } {
  const { serviceName: name, identifier } = context;
  const inNetwork =
    context.networkVpcId !== null && vpcId === context.networkVpcId;
  if (inNetwork) return { refusal: null, lines: [] };
  const where = `${identifier} is in ${vpcId ? `VPC ${vpcId}` : 'a VPC AWS did not name'}, ${context.networkVpcId ? `not this Environment network's VPC ${context.networkVpcId}` : 'and this Environment network is not made yet'}`;
  if (!context.madeReachable) {
    return {
      refusal: `${name} uses the existing database ${identifier}, but ${where}. Once you have made it reachable from this Environment, tick "I made it reachable from this Environment" on ${name}'s page; Cloudgate cannot check it`,
      lines: [],
    };
  }
  return {
    refusal: null,
    lines: [
      `${name}: ${where}; you ticked that you made it reachable from this Environment, which Cloudgate cannot check`,
    ],
  };
}

/** The major of `17.4`, `postgres:17`, `redis:7` or `17-alpine`, or `null`. */
export function majorOf(version: string | null): number | null {
  if (!version) return null;
  const match = /(\d+)/.exec(version.split(':').at(-1) ?? '');
  return match ? Number(match[1]) : null;
}
