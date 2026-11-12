import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { WORKLOAD_SERVICE_TYPES } from '../../applications/application.schema';

/**
 * The container-id charset, shared by container ids and app names: these
 * values are interpolated into shell commands, so only safe characters pass.
 */
export const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;

/**
 * `.nullish()`, not `.optional()`: a Service on the platform host carries
 * `serverId: null` on its row, so `null` is the value a client reads and
 * round-trips back. ADR-0008's "no server row to check" contract makes the
 * absent server the platform host, and `checkServerAccess` already collapses
 * `null` and `undefined` to the same branch — only validation disagreed, with a
 * 400 on a value the API itself hands out. Widening, so nothing that was
 * accepted stops being.
 */
const serverId = z.string().nullish();
const appName = z.string().min(1).regex(containerIdRegex, 'Invalid app name.');

export class ServerIdQueryDto extends createZodDto(z.object({ serverId })) {}

export class ServerIdBodyDto extends createZodDto(z.object({ serverId })) {}

export class ContainerIdParamsDto extends createZodDto(
  z.object({
    containerId: z
      .string()
      .min(1)
      .regex(containerIdRegex, 'Invalid container id.'),
  }),
) {}

export class ContainersByOwnerLabelQueryDto extends createZodDto(
  z.object({
    appName,
    appType: z.enum(['stack', 'docker-compose']).optional(),
    serverId,
  }),
) {}

export class ContainersByAppLabelQueryDto extends createZodDto(
  z.object({
    appName,
    type: z.enum(['standalone', 'swarm']),
    serverId,
  }),
) {}

export class AppNameQueryDto extends createZodDto(
  z.object({ appName, serverId }),
) {}

/**
 * A Service addressed by its own id and kind: the Shell tab's
 * `GET /docker/services/:serviceType/:serviceId/containers`. Every kind that
 * runs a workload of its own — a bucket has no container to open a shell in.
 * The id is never interpolated into a command; it only selects a row.
 */
export class ServiceContainersParamsDto extends createZodDto(
  z.object({
    serviceType: z.enum(WORKLOAD_SERVICE_TYPES),
    serviceId: z.string().min(1),
  }),
) {}

export class UploadFileBodyDto extends createZodDto(
  z.object({ destinationPath: z.string().min(1), serverId }),
) {}

/**
 * The one DTO in this file that went without `containerIdRegex`, while its four
 * siblings above all carry it. A swarm node id reaches
 * `docker node inspect` (`GET /swarm/nodes/:nodeId`) and `docker node update` /
 * `docker node rm` (`DELETE /cluster/nodes/:nodeId`), both on `server:*` — not
 * member-reachable, but `server` is in `enterpriseOnlyResources`, so a licensed
 * custom role can be granted it (the threat model).
 *
 * Refused rather than quoted, unlike `dockerImage`: a node id is an opaque
 * daemon-minted token with nothing user-meaningful to preserve, and one line
 * here covers both sinks. The sinks quote their own words as well — that is
 * `builders/build-strategy.ts`'s rule, not a substitute for this.
 */
export class NodeIdParamsDto extends createZodDto(
  z.object({
    nodeId: z.string().min(1).regex(containerIdRegex, 'Invalid node id.'),
  }),
) {}

// `?appName=a&appName=b` arrives as an array, a single `?appName=a` as a
// string — normalized to a string[].
export class AppInfosQueryDto extends createZodDto(
  z.object({
    appName: z.preprocess(
      (value): unknown[] =>
        value === undefined
          ? []
          : Array.isArray(value)
            ? (value as unknown[])
            : [value],
      z.array(appName),
    ),
    serverId,
  }),
) {}
