/**
 * **The Docker Locked setting list** (ADR-0044 rules 7–9): which values
 * a Service's Swarm settings may not hold, and why, in one place.
 *
 * Docker's settings are an allow-list of keys (the seven `native.docker` keys)
 * with this short deny-list of values inside them: three label
 * namespaces, stop-first on a database, and Docker's own documented lists for
 * its three free-text values. Nothing else in the seven is locked.
 *
 * **One list, three readers.** The console's save refuses these values (the
 * Swarm DTOs in `applications/swarm.types.ts` and the database DTOs), the
 * deploy refuses them in a stored row (`generateConfigContainer`, which both an
 * Application's and a database's spec pass through), and the plan will refuse
 * them in a `native.docker` block. Each reader asks this module rather
 * than holding a copy, so a value locked here is locked on every path at once
 * (H-56 and H-82 paired the DTO and the emitter for that reason; this is the
 * same pairing with the plan as its third reader).
 *
 * **Refused by path, never stripped or overwritten** (rule 9). A refusal
 * names the Docker Engine path (`UpdateConfig.Order`, `Labels."traefik.x"`) and
 * a one-line reason, and the caller refuses the whole save or the whole
 * Deployment. The deploy used to force a database's stored `start-first` to
 * stop-first instead: what ran was then not what the console showed,
 * which is the gap ADR-0029 rules out.
 *
 * Paths are in the Engine API's spelling, which is also `native.docker`'s
 * inner spelling, so the plan prefixes `native.docker.` and the console maps
 * the first segment to its column; neither has to translate.
 */

/** Docker's restart conditions (`RestartPolicy.Condition`). */
export const DOCKER_RESTART_CONDITIONS = ['none', 'on-failure', 'any'] as const;

/** Docker's update and rollback orders (`UpdateConfig.Order`). */
export const DOCKER_ORDERS = ['stop-first', 'start-first'] as const;

/** Docker's update and rollback failure actions (`FailureAction`). */
export const DOCKER_FAILURE_ACTIONS = [
  'pause',
  'continue',
  'rollback',
] as const;

export type DockerRestartCondition = (typeof DOCKER_RESTART_CONDITIONS)[number];
export type DockerOrder = (typeof DOCKER_ORDERS)[number];
export type DockerFailureAction = (typeof DOCKER_FAILURE_ACTIONS)[number];

const inList =
  <T extends string>(values: readonly T[]) =>
  (value: string): value is T =>
    values.some((listed) => listed === value);

export const isDockerRestartCondition = inList(DOCKER_RESTART_CONDITIONS);
export const isDockerOrder = inList(DOCKER_ORDERS);
export const isDockerFailureAction = inList(DOCKER_FAILURE_ACTIONS);

/** The one-line reason a value outside one of Docker's lists earns. */
const outsideListReason = (values: readonly string[]) =>
  `Docker takes only ${values.slice(0, -1).join(', ')} or ${values[values.length - 1]} here`;

export const RESTART_CONDITION_MESSAGE = outsideListReason(
  DOCKER_RESTART_CONDITIONS,
);
export const ORDER_MESSAGE = outsideListReason(DOCKER_ORDERS);
export const FAILURE_ACTION_MESSAGE = outsideListReason(DOCKER_FAILURE_ACTIONS);

/**
 * The label namespace Traefik's Docker/Swarm provider reads as router
 * configuration (H-56).
 *
 * Matched case-**insensitively** and anchored to a whole segment: `traefik` on
 * its own and any key beginning `traefik.`. The lowercase `traefik.` form is
 * the live one — reproduced against a default-install `traefik.yml`, whose
 * `providers.docker` reads the labels a Swarm service's `ContainerSpec.Labels`
 * put on its task containers, exactly where `mechanize.ts` writes `labelsSwarm`.
 * The uppercase arms are pre-emptive: Traefik 3.6 lowercases a label key before
 * matching its prefix, so `TRAEFIK.` is inert *today* — but the prefix is a
 * provider option a future config could change, and a rule that only refused
 * the lowercase spelling would silently reopen if it did.
 */
export const TRAEFIK_LABEL_NAMESPACE = /^traefik(\.|$)/i;

export const TRAEFIK_LABEL_MESSAGE =
  'A service label may not be in the "traefik" namespace: those keys are router configuration for the ingress every domain on the server shares';

/**
 * The label namespace Docker's own orchestrators write, and the one Cloudgate
 * reads to decide **which organization owns a container** (H-82).
 *
 * `com.docker.swarm.service.name`, `com.docker.compose.project` and
 * `com.docker.stack.namespace` are `OWNER_LABELS`
 * (`realtime/container-access.service.ts`): they are how the container listing
 * hides another organization's rows and how every container-addressed
 * route resolves a container to a Service. `com.docker.compose.service`
 * and `com.docker.swarm.task.name` are read the same way by the backup, volume
 * and stats paths. All of them were accepted keys whose values were entirely
 * unconstrained, and `ContainerSpec.Labels` is what puts a label on the task
 * containers `docker ps` then lists.
 *
 * Two consequences, both reproduced at the parsers rather than argued from the
 * source: a value containing the ` | ` the listing rows are split on shifts the
 * fields, so the real owner is discarded and a fragment takes its place; and a
 * value naming another organization's app makes a container claim an owner it
 * does not have. The parsers are not where this is fixed — a caller may not
 * write these keys at all, which is one rule instead of a delimiter change in
 * four listings.
 *
 * **Bounded deliberately, because it is why this is hardening and not a
 * cross-tenant read:** labels are writable only on one's own service, so both
 * consequences act on the caller's *own* container. Nothing here makes a
 * victim's container visible to an attacker.
 *
 * Matched case-insensitively for consistency with the sibling rule: unlike
 * Traefik, `docker ps --format '{{.Label "…"}}'` is an **exact,
 * case-sensitive** key lookup, so the uppercase arms are pre-emptive only.
 */
export const DOCKER_LABEL_NAMESPACE = /^com\.docker(\.|$)/i;

export const DOCKER_LABEL_MESSAGE =
  'A service label may not be in the "com.docker" namespace: those keys are how Cloudgate decides which organization owns a container';

/**
 * The namespace **reserved for the marks Cloudgate writes** (ADR-0044 rule
 * 8). Nothing writes one yet; it is reserved before anything does, so
 * that when a mark lands (an Environment, a Project, the Service it belongs
 * to) no stored row or config file already carries a forged one. Reserving it
 * later would turn every such row into a failed Deployment at once.
 * `container-access.service.ts` names `io.cloudgate.platform` as the shape a
 * platform mark would take.
 */
export const CLOUDGATE_LABEL_NAMESPACE = /^io\.cloudgate(\.|$)/i;

export const CLOUDGATE_LABEL_MESSAGE =
  'A service label may not be in the "io.cloudgate" namespace: it is reserved for the marks Cloudgate writes on what it runs';

/**
 * Every label namespace a Service's Swarm labels may not use, with the
 * refusal each earns. A fourth namespace is one entry here, and the console's
 * save, the deploy and the plan all refuse it from then on.
 *
 * The compose path selects its own arm from this list by identity
 * (`COMPOSE_REFUSED_LABEL_NAMESPACES`) because it writes `traefik.*` itself.
 */
export const REFUSED_LABEL_NAMESPACES: ReadonlyArray<{
  pattern: RegExp;
  message: string;
}> = [
  { pattern: TRAEFIK_LABEL_NAMESPACE, message: TRAEFIK_LABEL_MESSAGE },
  { pattern: DOCKER_LABEL_NAMESPACE, message: DOCKER_LABEL_MESSAGE },
  { pattern: CLOUDGATE_LABEL_NAMESPACE, message: CLOUDGATE_LABEL_MESSAGE },
];

/**
 * The stop-first exception (ADR-0044 rule 7): two copies of a database
 * on one volume are two writers to one data directory, and that corrupts it.
 */
export const DATABASE_ORDER_MESSAGE =
  'A database updates and rolls back stop-first: two copies on one volume corrupt data';

/**
 * Which Service a set of Swarm settings belongs to, for the one lock that
 * differs: a database's spec (`buildDatabaseServiceSpec`, every engine and the
 * bucket's Garage alike) must update and roll back stop-first.
 */
export type DockerLockRole = 'application' | 'database';

/** The four of the seven Swarm settings a lock reaches into. */
export interface DockerLockedSettings {
  Labels?: Record<string, string> | null | undefined;
  RestartPolicy?: { Condition?: string | undefined } | null | undefined;
  UpdateConfig?: DockerUpdateLike | null | undefined;
  RollbackConfig?: DockerUpdateLike | null | undefined;
}

interface DockerUpdateLike {
  Order?: string | undefined;
  FailureAction?: string | undefined;
}

/**
 * Which lock a refusal comes from: a reserved label namespace, the database
 * stop-first exception, or a value outside one of Docker's documented lists.
 */
export type DockerLock = 'label-namespace' | 'database-order' | 'docker-list';

/** One locked value: where it is, what it is and why it is refused. */
export interface DockerLockRefusal {
  lock: DockerLock;
  /** Engine API path: `['UpdateConfig', 'Order']`, `['Labels', '<key>']`. */
  path: readonly string[];
  /** The refused value; for a label, its key. */
  value: string;
  reason: string;
}

/**
 * Every locked value in `settings`, in the order an operator reads them
 * (labels, restart policy, update, rollback); an empty list when none is.
 *
 * Every refusal is returned, not the first, so one save or one failed
 * Deployment names everything there is to correct.
 */
export function dockerLockRefusals(
  settings: DockerLockedSettings,
  role: DockerLockRole,
): DockerLockRefusal[] {
  const refusals: DockerLockRefusal[] = [];

  for (const key of Object.keys(settings.Labels ?? {})) {
    const namespace = REFUSED_LABEL_NAMESPACES.find(({ pattern }) =>
      pattern.test(key),
    );
    if (namespace) {
      refusals.push({
        lock: 'label-namespace',
        path: ['Labels', key],
        value: key,
        reason: namespace.message,
      });
    }
  }

  const condition = settings.RestartPolicy?.Condition;
  if (condition !== undefined && !isDockerRestartCondition(condition)) {
    refusals.push({
      lock: 'docker-list',
      path: ['RestartPolicy', 'Condition'],
      value: condition,
      reason: RESTART_CONDITION_MESSAGE,
    });
  }

  for (const block of ['UpdateConfig', 'RollbackConfig'] as const) {
    const { Order, FailureAction } = settings[block] ?? {};
    if (Order !== undefined) {
      if (!isDockerOrder(Order)) {
        refusals.push({
          lock: 'docker-list',
          path: [block, 'Order'],
          value: Order,
          reason: ORDER_MESSAGE,
        });
      } else if (role === 'database' && Order !== 'stop-first') {
        refusals.push({
          lock: 'database-order',
          path: [block, 'Order'],
          value: Order,
          reason: DATABASE_ORDER_MESSAGE,
        });
      }
    }
    if (FailureAction !== undefined && !isDockerFailureAction(FailureAction)) {
      refusals.push({
        lock: 'docker-list',
        path: [block, 'FailureAction'],
        value: FailureAction,
        reason: FAILURE_ACTION_MESSAGE,
      });
    }
  }

  return refusals;
}

/**
 * One refusal as an operator reads it: the path (a label key quoted, since it
 * holds dots), the value when it is not already the path's last segment, and
 * the reason. `prefix` puts the file's own spelling in front, as
 * `native.docker.` for the plan:
 *
 *     native.docker.Labels."traefik.http.routers.x": refused - <reason>
 *     UpdateConfig.Order "start-first": refused - <reason>
 */
export function formatDockerRefusal(
  refusal: DockerLockRefusal,
  prefix = '',
): string {
  const [head, ...rest] = refusal.path;
  if (head === 'Labels') {
    return `${prefix}Labels.${JSON.stringify(refusal.value)}: refused - ${refusal.reason}`;
  }
  const path = [head, ...rest].join('.');
  return `${prefix}${path} ${JSON.stringify(refusal.value)}: refused - ${refusal.reason}`;
}

/**
 * The deploy's reading of the list: a stored row carrying a locked value fails
 * that Service's Deployment, naming every such value, before any Docker call
 * (the native settings spec). Thrown rather than stripped, because a
 * half-applied spec is worse than a failed deploy the operator can read and
 * correct — and the console refuses the same values, so the fix is one save.
 */
export function refuseLockedDockerSettings(
  settings: DockerLockedSettings,
  role: DockerLockRole,
): void {
  const refusals = dockerLockRefusals(settings, role);
  if (refusals.length === 0) return;
  throw new Error(
    `This service's stored Swarm settings hold a locked value: ${refusals
      .map((refusal) => formatDockerRefusal(refusal))
      .join(
        '; ',
      )}. Correct them in its Swarm settings; a deploy cannot be given them`,
  );
}
