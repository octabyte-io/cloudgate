import { NotFoundException } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { z } from 'zod';
import type {
  ServiceType,
  WorkloadServiceType,
} from '../../applications/application.schema';
import { LibsqlController } from '../../databases/libsql/libsql.controller';
import { LibsqlService } from '../../databases/libsql/libsql.service';
import { MariadbController } from '../../databases/mariadb/mariadb.controller';
import { MariadbService } from '../../databases/mariadb/mariadb.service';
import { MongoController } from '../../databases/mongo/mongo.controller';
import { MongoService } from '../../databases/mongo/mongo.service';
import { MysqlController } from '../../databases/mysql/mysql.controller';
import { MysqlService } from '../../databases/mysql/mysql.service';
import { PostgresController } from '../../databases/postgres/postgres.controller';
import { PostgresService } from '../../databases/postgres/postgres.service';
import { RedisController } from '../../databases/redis/redis.controller';
import { RedisService } from '../../databases/redis/redis.service';
import type {
  BuiltServiceType,
  DeploymentsService,
} from '../../deployments/deployments.service';
import { SERVICE_SOURCES } from '../../environments/environment-services';
import type { PermissionCtx } from '../../rbac/permission.service';
import type { SecretRoot } from '../secret-mask';

/**
 * What the Service tools (`service.tools.ts`, `write.tools.ts`) say the same
 * way: the Service kinds a tool takes, the `serviceId` argument,
 * the six database engines each kind-routed tool routes to, the mask root a
 * Service's row is, and the narrowing of a Deployment to the Service it
 * builds.
 */

/** Every Service kind, as `get_environment` lists them. */
export const SERVICE_TYPES = Object.keys(SERVICE_SOURCES) as [
  ServiceType,
  ...ServiceType[],
];

/** The two kinds that build, and so have Deployments and Domains. */
export const BUILT_TYPES = [
  'application',
  'compose',
] as const satisfies readonly BuiltServiceType[];

export const serviceIdArg = z
  .string()
  .min(1)
  .describe('A serviceId from get_environment');

export const serviceTypeArg = z
  .enum(SERVICE_TYPES)
  .describe('The kind of Service, as get_environment lists it');

/**
 * Every kind but a bucket: the kinds that run a workload of their
 * own, which is what starting and stopping one is about.
 */
export const WORKLOAD_TYPES = SERVICE_TYPES.filter(
  (type): type is WorkloadServiceType => type !== 'bucket',
) as [WorkloadServiceType, ...WorkloadServiceType[]];

export const workloadTypeArg = z
  .enum(WORKLOAD_TYPES)
  .describe(
    'The kind of Service, as get_environment lists it; a bucket runs nothing to start or stop',
  );

/** What every kind's `findOne` answers that `get_service` reads. */
export interface ServiceFound {
  name: string;
  appName: string;
  /** The fixed key a Project config uses for the Service. */
  configName: string;
  description: string | null;
  createdAt: string;
  environment: {
    environmentId: string;
    name: string;
    project: { projectId: string; name: string };
  };
}

/**
 * What the tools call on a database engine's service — `BaseDatabaseService`
 * for all six — so each engine in {@link DATABASE_ENGINES} is checked against
 * it where it is listed.
 */
export interface EngineService {
  findOne(
    ctx: PermissionCtx,
    databaseId: string,
  ): Promise<ServiceFound & { applicationStatus: string }>;
  start(
    ctx: PermissionCtx,
    id: string,
    options: { detach?: boolean },
  ): Promise<unknown>;
  stop(
    ctx: PermissionCtx,
    id: string,
    options: { detach?: boolean },
  ): Promise<unknown>;
}

/** The six database engines: every kind that neither builds nor is a bucket. */
export type EngineType = Exclude<WorkloadServiceType, BuiltServiceType>;

/** The six database engines: each one's service and HTTP twin controller. */
export const DATABASE_ENGINES = {
  postgres: { service: PostgresService, controller: PostgresController },
  mysql: { service: MysqlService, controller: MysqlController },
  mariadb: { service: MariadbService, controller: MariadbController },
  mongo: { service: MongoService, controller: MongoController },
  redis: { service: RedisService, controller: RedisController },
  libsql: { service: LibsqlService, controller: LibsqlController },
} as const satisfies Record<
  EngineType,
  { service: Type<EngineService>; controller: Type<unknown> }
>;

/** One route per database engine, built by `route` from its service and twin. */
export function engineRoutes<Route>(
  route: (
    serviceType: EngineType,
    service: Type<EngineService>,
    controller: Type<unknown>,
  ) => Route,
): Record<EngineType, Route> {
  return Object.fromEntries(
    Object.entries(DATABASE_ENGINES).map(([serviceType, engine]) => [
      serviceType,
      route(serviceType as EngineType, engine.service, engine.controller),
    ]),
  ) as Record<EngineType, Route>;
}

/** The Service's own row, which the mask walks from. */
export function serviceRoot(target: {
  serviceType: ServiceType;
  serviceId: string;
}): SecretRoot {
  return {
    table: SERVICE_SOURCES[target.serviceType].table,
    id: target.serviceId,
  };
}

/**
 * The Application or Compose a Deployment builds. Any other owner — a
 * schedule's or a backup's run, or none — answers exactly as an unknown id
 * does, before the tool's own service call.
 */
export async function buildOwnerOf(
  service: DeploymentsService,
  deploymentId: string,
): Promise<{ serviceType: BuiltServiceType; serviceId: string }> {
  const owner = await service.serviceOwnerOf(deploymentId);
  if (!owner) throw new NotFoundException();
  return owner;
}
