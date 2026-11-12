import { z } from 'zod';
import { CLOUDGATE_AI_NETWORK } from '../ai-models/ai-network';
import {
  dockerLockRefusals,
  FAILURE_ACTION_MESSAGE,
  isDockerFailureAction,
  isDockerOrder,
  isDockerRestartCondition,
  ORDER_MESSAGE,
  RESTART_CONDITION_MESSAGE,
} from '../native/docker-locks';
import type {
  DockerFailureAction,
  DockerLockedSettings,
  DockerLockRole,
  DockerOrder,
  DockerRestartCondition,
} from '../native/docker-locks';

// Swarm config shapes: typed JSON columns on the application table, passed
// through to the Docker service spec at deploy time. Field names are PascalCase
// because they mirror the Docker Engine API.

export interface HealthCheckSwarm {
  Test?: string[] | undefined;
  Interval?: number | undefined;
  Timeout?: number | undefined;
  StartPeriod?: number | undefined;
  Retries?: number | undefined;
}

/**
 * `Condition`, `Order` and `FailureAction` are Docker's documented lists, not
 * free text: the lists, and the refusal of anything else, are the
 * Docker lock list's (`native/docker-locks.ts`).
 */
export interface RestartPolicySwarm {
  Condition?: DockerRestartCondition | undefined;
  Delay?: number | undefined;
  MaxAttempts?: number | undefined;
  Window?: number | undefined;
}

export interface PlacementSwarm {
  Constraints?: string[] | undefined;
  Preferences?: Array<{ Spread: { SpreadDescriptor: string } }> | undefined;
  MaxReplicas?: number | undefined;
  Platforms?:
    | Array<{
        Architecture: string;
        OS: string;
      }>
    | undefined;
}

export interface UpdateConfigSwarm {
  Parallelism: number;
  Delay?: number | undefined;
  FailureAction?: DockerFailureAction | undefined;
  Monitor?: number | undefined;
  MaxFailureRatio?: number | undefined;
  Order: DockerOrder;
}

export interface ServiceModeSwarm {
  Replicated?: { Replicas?: number | undefined } | undefined;
  Global?: object | undefined;
  ReplicatedJob?:
    | {
        MaxConcurrent?: number | undefined;
        TotalCompletions?: number | undefined;
      }
    | undefined;
  GlobalJob?: object | undefined;
}

export interface NetworkSwarm {
  Target?: string | undefined;
  Aliases?: string[] | undefined;
  DriverOpts?: { [key: string]: string } | undefined;
}

export interface LabelsSwarm {
  [name: string]: string;
}

/**
 * The Swarm protocols and publish modes the Docker API accepts (H-56).
 *
 * The stored column and the DTO both keep these as bare `string` — the column
 * predates the rule and `endpointSpecSwarmSchema` narrows with a `.refine` that
 * outputs `string` so `openapi.json` is untouched (§2.11). The unions exist for
 * the one place the value has to *be* a union: `mechanize.ts`, which passes it
 * to the Docker service spec. {@link toEndpointProtocol} / {@link toPublishMode}
 * do that narrowing with a membership check, replacing the unchecked `as` cast
 * that let a bad stored string reach the API typed as valid.
 */
export type EndpointProtocolSwarm = 'tcp' | 'udp' | 'sctp';
export type PublishModeSwarm = 'ingress' | 'host';

const ENDPOINT_PROTOCOLS: readonly EndpointProtocolSwarm[] = [
  'tcp',
  'udp',
  'sctp',
];
const PUBLISH_MODES: readonly PublishModeSwarm[] = ['ingress', 'host'];

/**
 * Narrow a stored `Protocol` to the Docker union, defaulting an absent or —
 * for a row written before {@link endpointSpecSwarmSchema}'s rule, or by a
 * `.partial()` PATCH that never parsed it — out-of-union value to `tcp`, the
 * same fallback the empty case already took. A membership-checked narrowing,
 * not the `as` cast it replaces: a value Docker would reject cannot leave here
 * typed as one it accepts (H-56).
 */
export function toEndpointProtocol(
  value: string | undefined,
): EndpointProtocolSwarm {
  return ENDPOINT_PROTOCOLS.find((protocol) => protocol === value) ?? 'tcp';
}

/** Narrow a stored `PublishMode` to the Docker union, defaulting to `host`;
 * {@link toEndpointProtocol}'s reasoning, the other field (H-56). */
export function toPublishMode(value: string | undefined): PublishModeSwarm {
  return PUBLISH_MODES.find((mode) => mode === value) ?? 'host';
}

export interface EndpointPortConfigSwarm {
  Protocol?: string | undefined;
  TargetPort?: number | undefined;
  PublishedPort?: number | undefined;
  PublishMode?: string | undefined;
}

export interface EndpointSpecSwarm {
  Mode?: string | undefined;
  Ports?: EndpointPortConfigSwarm[] | undefined;
}

export interface UlimitSwarm {
  Name: string;
  Soft: number;
  Hard: number;
}

export type UlimitsSwarm = UlimitSwarm[];

export const healthCheckSwarmSchema = z
  .object({
    Test: z.array(z.string()).optional(),
    Interval: z.number().optional(),
    Timeout: z.number().optional(),
    StartPeriod: z.number().optional(),
    Retries: z.number().optional(),
  })
  .strict();

/**
 * A refinement of `z.string()` to one of Docker's lists rather than a
 * `z.enum`, on the `Protocol` precedent below (§2.11): `openapi.json` keeps its
 * `{ "type": "string" }`, and the type guard still narrows the output to the
 * union the columns are typed with.
 */
const dockerListed = <T extends string>(
  guard: (value: string) => value is T,
  message: string,
) => z.string().refine(guard, message);

export const restartPolicySwarmSchema = z
  .object({
    Condition: dockerListed(
      isDockerRestartCondition,
      RESTART_CONDITION_MESSAGE,
    ).optional(),
    Delay: z.number().optional(),
    MaxAttempts: z.number().optional(),
    Window: z.number().optional(),
  })
  .strict();

export const placementSwarmSchema = z
  .object({
    Constraints: z.array(z.string()).optional(),
    Preferences: z
      .array(
        z
          .object({
            Spread: z.object({ SpreadDescriptor: z.string() }),
          })
          .strict(),
      )
      .optional(),
    MaxReplicas: z.number().optional(),
    Platforms: z
      .array(
        z
          .object({
            Architecture: z.string(),
            OS: z.string(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const updateConfigSwarmSchema = z
  .object({
    Parallelism: z.number(),
    Delay: z.number().optional(),
    FailureAction: dockerListed(
      isDockerFailureAction,
      FAILURE_ACTION_MESSAGE,
    ).optional(),
    Monitor: z.number().optional(),
    MaxFailureRatio: z.number().optional(),
    Order: dockerListed(isDockerOrder, ORDER_MESSAGE),
  })
  .strict();

/**
 * The Docker lock list's refusals of one Swarm setting, as issues on the
 * console's save (ADR-0044 rule 9): each at its own path under the
 * column, with its one-line reason. The deploy reads the same list for a
 * stored row (`generateConfigContainer`), so the two cannot disagree.
 *
 * A value outside Docker's lists is refused at its field by `dockerListed`,
 * whose type guard is what narrows the column's type, so this adds only the
 * locks a field cannot hold: label namespaces and a database's order.
 */
export function refuseLockedSwarm<K extends keyof DockerLockedSettings>(
  key: K,
  role: DockerLockRole,
) {
  return (
    value: NonNullable<DockerLockedSettings[K]>,
    ctx: z.RefinementCtx,
  ) => {
    for (const refusal of dockerLockRefusals({ [key]: value }, role)) {
      if (refusal.lock === 'docker-list') continue;
      ctx.addIssue({
        code: 'custom',
        path: refusal.path.slice(1),
        // A label's path is its key, which a console card does not show, so
        // the message names it too.
        message:
          refusal.lock === 'label-namespace'
            ? `${refusal.reason} — offending label: ${refusal.value}`
            : refusal.reason,
      });
    }
  };
}

export const serviceModeSwarmSchema = z
  .object({
    Replicated: z
      .object({ Replicas: z.number().optional() })
      .strict()
      .optional(),
    Global: z.object({}).strict().optional(),
    ReplicatedJob: z
      .object({
        MaxConcurrent: z.number().optional(),
        TotalCompletions: z.number().optional(),
      })
      .strict()
      .optional(),
    GlobalJob: z.object({}).strict().optional(),
  })
  .strict();

/**
 * The refusal of a Service that names `cloudgate-ai`. That overlay is
 * the AI models' alone: a Service on it could reach an inference
 * runtime by name, around the gateway that authorizes and meters every call.
 * An AI model's own place on it is written by the deploy, never stored here.
 */
export const AI_NETWORK_MESSAGE = `"${CLOUDGATE_AI_NETWORK}" is the AI models' own network: no other Service may join it, so nothing reaches a runtime around the gateway`;

/** Whether a stored or submitted network list names `cloudgate-ai`. */
export const namesAiNetwork = (
  networks: readonly { Target?: string }[] | null | undefined,
): boolean =>
  (networks ?? []).some((network) => network.Target === CLOUDGATE_AI_NETWORK);

/**
 * Shared by the Application and every database DTO, so the `cloudgate-ai`
 * refusal covers each of their REST routes in one place.
 */
export const networkSwarmSchema = z
  .array(
    z
      .object({
        Target: z.string().optional(),
        Aliases: z.array(z.string()).optional(),
        DriverOpts: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
  )
  .refine((networks) => !namesAiNetwork(networks), {
    message: AI_NETWORK_MESSAGE,
  });

/**
 * An application's or database's Swarm service labels, refusing any key in the
 * `traefik` namespace (H-56, the router-hijack shape already closed for a
 * Domain's `host` and `path`), in the `com.docker` namespace (H-82, the
 * ownership-model shape — see `DOCKER_LABEL_NAMESPACE`) or in the
 * `io.cloudgate` namespace reserved for Cloudgate's own marks. The
 * namespaces are the Docker lock list's (`native/docker-locks.ts`).
 *
 * **This is a live cross-tenant surface, not pre-emptive.** `labelsSwarm` was a
 * bare `z.record(z.string(), z.string())`; its keys and values become the
 * service's `ContainerSpec.Labels` verbatim (`mechanize.ts`,
 * `database-spec.ts`). A default install runs Traefik with `providers.docker`
 * enabled and the Docker socket bound (`deploy/traefik/traefik.yml.example`,
 * `deploy/install.sh`), and that provider reads container labels as dynamic
 * config. So a caller who could set arbitrary labels could define
 * `traefik.http.routers.<name>.rule=Host(\`victim.example.com\`)` with a high
 * `priority` and take over another tenant's domain — reproduced end to end
 * against `traefik:v3.6.7`: the hijack router out-prioritised the file-provider
 * router Cloudgate writes and `victim.example.com` served the attacker's
 * container. **Nothing Cloudgate deploys on *this* path carries a `traefik.*`
 * service label** — an Application's and a database's routing is the *file*
 * provider (`dynamic/cloudgate.yml`), not Docker labels — so refusing this
 * namespace costs no value the application path mints.
 *
 * **That sentence is deliberately scoped to this path and must not be read as a
 * claim about the product (H-83).** It is module-wide false: the compose path
 * mints `traefik.*` labels itself — `compose.utils.ts`'s
 * `createComposeDomainLabels` builds a router, a service, middlewares and a
 * `traefik.enable=true` for every Compose Domain, and the default catalogue's own
 * blueprints ship more of them. So a blanket namespace refusal is the right rule
 * *here* and the wrong rule *there*, where it would break four working
 * blueprints; the compose path checks hostname **ownership** inside the
 * namespace instead (`compose/compose-labels.ts`). Two rules, because the two
 * paths differ in what the product itself writes — not an inconsistency to
 * tidy up by making them uniform.
 *
 * **Refused, not stripped**, on the tree's standing precedent (`cleanAppName`,
 * `VOLUME_NAME_REGEX`): a label map silently rewritten is not the map the
 * caller asked for, and a router config that half-applied would be worse than a
 * 400. The rule is the namespace and not a metacharacter blocklist because the
 * value's *meaning* to Traefik is what is dangerous — a label is honoured or it
 * is not, and no escaping makes `traefik.http.routers…` safe.
 *
 * The same rule stands again at the emitter (`generateConfigContainer`), because
 * `updateApplicationSchema` is `.partial()` and a row stored before this rule is
 * never revisited by a PATCH that omits the field — the Domain `path` residual, one
 * schema over.
 */
export const labelsSwarmSchema = z
  .record(z.string(), z.string())
  // One issue per refused key, each carrying its namespace's own message:
  // "a service label may not be in the traefik namespace" and "…in the
  // com.docker namespace" are different corrections, not one generic 400.
  .superRefine(refuseLockedSwarm('Labels', 'application'));

export const endpointSpecSwarmSchema = z
  .object({
    Mode: z.string().optional(),
    Ports: z
      .array(
        z
          .object({
            // Held to the Docker unions, not left a bare string: `mechanize.ts`
            // passes these straight to the service spec, and did it through an
            // `as 'tcp' | …` cast that told the compiler a bad string was a
            // valid union (H-56). Constraining the value here is what makes that
            // cast unnecessary, so a protocol Docker would reject is a 400 at
            // the write rather than a converge failure the operator reads out of
            // `docker service ps`.
            //
            // `.refine` on `z.string()`, not `z.enum`, on the previewWildcard
            // precedent (§2.11): a refinement never reaches `openapi.json`,
            // where `z.enum` would rewrite the published `{ "type": "string" }`
            // into an enum and move every generated consumer for a rule that
            // only narrows what was already accepted. The compile-time union the
            // cast removal needs comes from `EndpointPortConfigSwarm` above, not
            // from this schema's inferred output.
            Protocol: z
              .string()
              .refine(
                (value) => ENDPOINT_PROTOCOLS.some((p) => p === value),
                'Protocol must be one of tcp, udp or sctp',
              )
              .optional(),
            TargetPort: z.number().optional(),
            PublishedPort: z.number().optional(),
            PublishMode: z
              .string()
              .refine(
                (value) => PUBLISH_MODES.some((m) => m === value),
                'PublishMode must be ingress or host',
              )
              .optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const ulimitsSwarmSchema = z.array(
  z
    .object({
      Name: z.string(),
      Soft: z.number(),
      Hard: z.number(),
    })
    .strict(),
);
