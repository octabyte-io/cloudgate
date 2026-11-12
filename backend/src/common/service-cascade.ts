import { ConflictException } from '@nestjs/common';
import { inArray } from 'drizzle-orm';
import {
  applicationServicePresence,
  reclaimApplicationDirectory,
  removeApplicationService,
  removeTraefikConfigStep,
} from '../applications/application-ops';
import type { BucketCascade } from '../buckets/bucket-deletes.service';
import type { BucketLeftBehind } from '../buckets/bucket-files';
import { removeBucketService } from '../buckets/bucket-ops';
import {
  aiModelIdsAmong,
  reclaimWeightsVolumes,
} from '../ai-models/weights-volume';
import type { WeightsVolumeOwner } from '../ai-models/weights-volume';
import { application } from '../applications/application.schema';
import type { ServiceType } from '../applications/application.schema';
import { reclaimBuildLeftovers } from '../applications/build-leftovers';
import { reclaimBuiltImages } from '../applications/built-image';
import type { BuiltImageOwner } from '../applications/built-image';
import {
  awaitComposeWorkloadAbsent,
  composeTeardownCommand,
  COMPOSE_SETTLE_BUDGET_MS,
  systemSettleClock,
} from '../compose/compose.utils';
import type { SettleClock } from '../compose/compose.utils';
import { reclaimComposeDirectory } from '../compose/compose-directory';
import {
  databaseServicePresence,
  removeDatabaseService,
} from '../databases/common/database-ops';
import type { DrizzleDB } from '../db/drizzle.module';
import { buildHostServerId } from '../deployment-engine/build-host';
import { listServicesInEnvironments } from '../environments/environment-services';
import { removeGatewayRouteStep } from '../gateway/gateway-route';
import type { SourceType } from '../git-providers/git-provider.schema';
// A plain function taking this file's `RemoteExecService`, on
// `preserved-images.ts`' and `preview-teardown.ts`' precedent: `patch/` is a
// module of services that inject `ApplicationsService`, and this module
// deliberately depends on no provider.
import { reclaimApplicationPatchRepos } from '../patch/patch-repo-clone';
import { execOnServerStdout } from '../remote/exec-dispatch';
import { ReachabilityMemo } from '../remote/reachability-memo';
import type { RemoteExecService } from '../remote/remote-exec.service';
import {
  isTraceServiceType,
  removeTraceStores,
  tracedServiceIdsOf,
} from '../traces/trace-store';
import type { TraceServiceType, TraceStoreOwner } from '../traces/trace-store';
import type { TraefikWriterService } from '../traefik/traefik-writer.service';
import { runLogOwnersOf } from './run-log-owners';
import {
  awaitImageRelease,
  reclaimDeploymentLogs,
  reclaimFileMounts,
  runTeardownSteps,
} from './teardown-steps';
import type {
  BuildHostArtifactOwner,
  ImageRelease,
  TeardownReport,
  TeardownStep,
  UnreclaimedArtifact,
  UnreclaimedImages,
} from './teardown-steps';
import type { OrphanedWorkload, WorkloadPresence } from './workload-presence';

// Deleting a Project or an Environment, in `CONTEXT.md`'s sense of **Delete**,
// for every Service beneath it.
//
// `projects.service.ts` and `environments.service.ts` were bare `db.delete`
// calls over an `onDelete: 'cascade'` chain, so one statement dropped the rows
// of every Application, compose stack and database in the tree while every one
// of their swarm services, containers, networks and project directories kept
// running. Per ADR-0008 a container that resolves to no Service is *unmanaged*
// and is reached through machine-level `docker:read` — "where there is no
// Service to ask about" — so once "managed" decided access, that single statement moved
// every workload in a Project from private-to-one-organization to readable and
// actable by every organization on the host, at once. That is the orphan finding in
// bulk, and by the path an operator is most likely to take: deleting a Project
// is one click, deleting eleven Services individually is eleven.
//
// This is the collaborator both deletes drive, and it is deliberately *not* an
// `@Injectable()`. `ProjectsService` and `EnvironmentsService` would otherwise
// have to reach `ApplicationsService`, `ComposeService` and six database
// services, every one of which already resolves an Environment through the
// projects and environments modules — a `forwardRef` knot for what is really a
// pure sequence over three exported teardowns. Everything here is a function
// taking the two collaborators it needs, so it costs no module wiring beyond
// `TraefikModule`, which only the Application arm uses.
//
// **There is no partial delete.** Every child is torn down and confirmed, and
// if any one of them is `'present'` or `'unknown'` the caller answers 409 with
// the whole tree intact. A cascade that deleted what it could and reported the
// rest would leave an operator holding a half-deleted Project whose remaining
// rows they cannot reason about, and — worse — would still have orphaned
// whichever workloads it *did* drop rows for. `?force=true` forces every child
// and names what it left behind, exactly as the per-Service deletes do.

/** The teardown-shaped view of one Service under a Project or Environment. */
export interface CascadeChild {
  serviceType: ServiceType;
  serviceId: string;
  appName: string;
  /** Where the workload runs: the Swarm service, the probe, the Traefik file. */
  serverId: string | null;
  /**
   * Where an Application's build artifacts are — `null` for every other
   * `serviceType`, which have no build-Server concept at all.
   *
   * A second Server on the child because the two are genuinely two: the source
   * tree is created on {@link buildHostServerId}'s answer and everything else
   * here belongs to `serverId`, and this file removed the tree from `serverId`
   * until a fix. It is not `buildHostServerId`'s answer already resolved,
   * because `teardownStepsFor` is the place that decides which artifact wants
   * which machine and a pre-collapsed id would hide that decision from it.
   */
  buildServerId: string | null;
  /**
   * Which source an Application builds from — `null` for every other
   * `serviceType`, and for an Application row that has gone between the two
   * selects.
   *
   * Here for exactly one question, and it is a question about *safety* rather
   * than about topology: whether the delete may remove `${appName}:latest` on
   * the build host. `applications/built-image.ts`' `builtImageTag` answers
   * `null` for `'docker'`, because that arm's image is the operator's own
   * `dockerImage` column — pulled rather than built, possibly shared with every
   * other Application on the machine — and the reclamation must not name it.
   * A cascade holding no `sourceType` would either have to skip the image
   * reclamation entirely or guess, and guessing here deletes somebody's
   * `postgres:17`.
   */
  sourceType: SourceType | null;
  /**
   * The run records this Service's delete cascades away — its schedules,
   * backups and volume backups — as the owners of deployment-log directories.
   * Read by {@link listCascadeChildren} before any row is deleted,
   * since afterwards there is nothing to read; `common/run-log-owners.ts`
   * carries which machine each one wrote to.
   */
  runLogs: readonly { appName: string; serverId: string | null }[];
  /**
   * Whether this Service has a `trace_store` row, and so may have a Trace
   * store on its run Server for the cascade to reclaim. Read by
   * {@link listCascadeChildren} for `runLogs`' reason: the row cascades with
   * the Service, so afterwards nothing says there was one.
   */
  traced: boolean;
  /**
   * Whether this child is an AI model, and so has a weights volume on its run
   * Server that every Delete reclaims and a gateway-only router there
   * for the cascade to remove. Read by {@link listCascadeChildren} for
   * `traced`'s reason: the facet cascades with the Application.
   */
  aiModel: boolean;
}

/**
 * The two boundaries a cascade crosses. Both `import type`, exactly as
 * `databases/common/database-ops.ts` takes its `RemoteExecService`: the shape
 * is shared, the runtime coupling is not.
 */
export interface CascadeDeps {
  remoteExec: RemoteExecService;
  traefikWriter: TraefikWriterService;
  /**
   * The settle poll's clock (H-105), optional and defaulting to the system one.
   *
   * Neither `ProjectsService` nor `EnvironmentsService` passes it: the wait is
   * an implementation detail of the compose arm, and threading
   * `COMPOSE_SETTLE_CLOCK` through two more constructors would make both
   * modules depend on `ComposeModule` for a `Date.now()`. The seam exists for
   * the tests, which is the same reason `ComposeService` has one — a spec that
   * has to exhaust a fifteen-second window must be able to do it in
   * microseconds, and the alternative is a suite that sleeps for a quarter of a
   * minute per assertion.
   */
  settleClock?: SettleClock;
}

/**
 * {@link CascadeDeps} as one Delete sees them: the exec layer is that Delete's
 * {@link ReachabilityMemo}, so a Server it could not connect to is
 * dialled once for the whole tree, not once per step per child.
 * {@link cascadeDelete} builds it; the steps and the presence reads take it.
 */
export type CascadeDeleteDeps = CascadeDeps & { remoteExec: ReachabilityMemo };

/** A parent row plus its orphans, for the two callers' return type. */
export type CascadeDeleted<TRow> = TRow & {
  orphaned?: OrphanedWorkload[];
  unreclaimedImages?: UnreclaimedImages[];
  /**
   * Previews whose Swarm service could not be confirmed gone. Its own
   * field rather than more entries in `orphaned`: that array is what the 409 is
   * decided on and what {@link cascadeRefusalMessage} counts against
   * `children.length`, and a preview is not a child — it has no `service_type`,
   * no row of its own in the eight tables and no `checkServiceAccess`.
   */
  orphanedPreviews?: OrphanedWorkload[];
  /**
   * The paths this delete could not confirm it removed, on the machines that
   * hold them — every child Application's source tree
   * and Traefik config, its previews' trees, its patch-repo clone, its
   * file-mounts tree and its Trace store, plus every managed database's
   * file-mounts tree, in the
   * order they were attempted, each carrying the `kind` that says which it is.
   * Two of those live on the **run** Server and three on the build host, so one
   * `appName` can name two machines here.
   *
   * A database contributes only the `'file-mounts'` entry: it has no source
   * tree, no Traefik config of its own and no build host to hold either.
   *
   * Its own field rather than an entry in `orphaned` for the same reason
   * `orphanedPreviews` is: `orphaned` is what the 409 is decided on, and a
   * failed removal never refuses a delete. `common/teardown-steps.ts` carries
   * the argument for reporting it at all — these are the teardown steps no
   * presence read can see, so before this they failed into an empty `catch` and
   * the route answered 200 having leaked artifacts it knew about — and the
   * argument for one field with a `kind` rather than one field per artifact.
   */
  unreclaimedArtifacts?: UnreclaimedArtifact[];
  /**
   * The buckets this Delete kept and names once: each one that
   * holds files or could not be read, with its volume. An Environment's or
   * Project's Delete never asks for a bucket's files to go, so every such
   * bucket is here; an empty one went whole.
   */
  bucketsLeftBehind?: BucketLeftBehind[];
};

// **A compose child carries no `composeType`, and that is the fix rather than an
// omission (H-87).** This file used to take one, and reasoned at length about the
// `null` case: the teardown was allowed to guess, because it is best-effort
// inside its own try/catch either way, and the probe was not, because `docker
// compose ps` against a project that is really a swarm stack answers nothing,
// `readWorkloadPresence` reads that as `'absent'`, and an `'absent'` is exactly
// what lets the row be dropped while the workload keeps running.
//
// That reasoning was right and it guarded the wrong half. The case it guarded —
// `null` — cannot occur: `compose.composeType` is `notNull` with a default, so
// the guard was dead code. The reachable case is a type that is *present and
// wrong*, because `updateComposeSchema` lets a caller `PATCH` it. One supported
// edit aimed both the teardown and the probe at the wrong daemon subsystem: the
// teardown failed into the `catch` where nothing sees it, and then the probe that
// exists to catch that asked the same wrong question. Both halves of the safety
// property keyed off one mutable field.
//
// So neither half keys off it any more — `composeTeardownCommand` takes both
// subsystems down and `readComposeWorkloadPresence` asks both questions,
// answering `'present'` if either does and never `'absent'` unless both do. There
// is nothing left here to guess about, so there is nothing left to carry, which
// also drops a per-cascade `select` on the compose table.

/**
 * What Delete does to this child, in the order the per-Service route does it,
 * each step best-effort inside {@link runTeardownSteps}. The switch is
 * exhaustive over `ServiceType` on purpose: a ninth engine that forgets to
 * register here would silently cascade with no teardown at all, which is the
 * defect this file exists to close.
 *
 * **A step, not a thunk** — `common/teardown-steps.ts`'s
 * {@link TeardownStep}, because some of these steps remove artifacts the
 * presence read cannot see and therefore have to say so themselves. The
 * Traefik config's carries a `leftBehindOnFailure`, as the source-tree
 * removal did until it moved after the refusal
 * ({@link reclaimServiceDirectories}); the workload removals do not, because {@link presenceOf}
 * answers for those and answers better — a failed `docker service rm` shows up
 * as `'present'`, which is a 409 rather than a line in a report.
 */
function teardownStepsFor(
  deps: CascadeDeleteDeps,
  child: CascadeChild,
): TeardownStep[] {
  const { remoteExec, traefikWriter } = deps;
  switch (child.serviceType) {
    case 'application':
      return [
        {
          run: () =>
            removeApplicationService(remoteExec, child.serverId, child.appName),
        },
        // Not optional: `domain.applicationId` cascades, so the domain rows go
        // with the Application, but the dynamic-config file they generated does
        // not — and without this the delete leaves a public hostname routed at
        // nothing. Which is also why it is one of the two steps that
        // names what it left: the presence read below asks this same
        // Server about a Swarm service and cannot see a file, so a failure here
        // was swallowed and a whole Project's hostnames could keep resolving at
        // backends that were gone, behind a clean 200.
        removeTraefikConfigStep(
          traefikWriter,
          child.serverId,
          child.appName,
          remoteExec,
        ),
        // An AI model's gateway-only router, its own file.
        ...(child.aiModel
          ? [removeGatewayRouteStep(remoteExec, child.serverId, child.appName)]
          : []),
        // Not the directory: `reclaimServiceDirectories` removes it
        // after the refusal.
      ];
    case 'compose':
      // The only arm that reaches the exec layer from this file: a compose
      // teardown and its presence probe are shell *programs*, so they stay
      // strings and their interpolations are quoted on the builders in
      // `compose/compose.utils.ts`. Every other arm goes through the ops
      // helper that already owns the command, which passes argv.
      return [
        {
          run: () =>
            execOnServerStdout(
              remoteExec,
              child.serverId,
              // `deleteVolumes: false` — volumes survive a Delete unless asked
              // for, and there is no way to ask at the Project level. The
              // project directory is `reclaimServiceDirectories`'.
              composeTeardownCommand(child.serverId, child.appName, false),
            ),
        },
      ];
    case 'postgres':
    case 'mysql':
    case 'mariadb':
    case 'mongo':
    case 'redis':
    case 'libsql':
      return [
        {
          run: () =>
            removeDatabaseService(remoteExec, child.serverId, child.appName),
        },
      ];
    case 'bucket':
      // Its Garage and its config secret. Its volume is the bucket's files,
      // which `cascadeDelete`'s `bucketFiles` settles once the tree is down
      // removed only when the bucket was empty. Its Domains' routes
      // go as an Application's do, and are named when they cannot.
      return [
        {
          run: () =>
            removeBucketService(remoteExec, child.serverId, child.appName),
        },
        removeTraefikConfigStep(
          traefikWriter,
          child.serverId,
          child.appName,
          remoteExec,
        ),
      ];
  }
}

/**
 * Whether this child's workload survived its teardown — three-valued, decided
 * in the shell, for the reason `common/workload-presence.ts` gives at length.
 *
 * `settleBudgetMs` is what is left of the **whole cascade's** settle deadline,
 * and only the compose arm spends any of it — see
 * {@link tearDownCascadeChildren}.
 */
function presenceOf(
  deps: CascadeDeps,
  child: CascadeChild,
  settleBudgetMs: number,
): Promise<WorkloadPresence> {
  const { remoteExec } = deps;
  switch (child.serviceType) {
    case 'application':
      return applicationServicePresence(
        remoteExec,
        child.serverId,
        child.appName,
      );
    case 'compose':
      // Both compose questions, not the row's type: see the note above
      // `teardownStepsFor`, and `readComposeWorkloadPresence` itself (H-87).
      // Polled rather than read once, for `ComposeService.remove`'s reason
      // (H-99/H-105): `docker stack rm` returns as soon as the daemon *accepts*
      // the removal while `docker stack ps` keeps naming tasks in `Shutdown` for
      // several seconds after, so a single immediate read answered `present`
      // about the teardown this very request had just issued.
      return awaitComposeWorkloadAbsent(
        child.appName,
        (command) => execOnServerStdout(remoteExec, child.serverId, command),
        deps.settleClock,
        settleBudgetMs,
      );
    case 'postgres':
    case 'mysql':
    case 'mariadb':
    case 'mongo':
    case 'redis':
    case 'libsql':
    case 'bucket':
      return databaseServicePresence(remoteExec, child.serverId, child.appName);
  }
}

/**
 * Every Service in the given Environments, in the shape a teardown needs.
 *
 * Reuses the union `EnvironmentsService.findOne` already runs rather than
 * fanning out over eight tables again. It used to add one lookup for the compose
 * rows' `composeType`; nothing needs it now that neither the compose teardown
 * nor the compose presence probe branches on it (H-87).
 *
 * **One lookup came back for the Application columns, and they are deliberately
 * not in the union.** The obvious move is to add them to
 * `SERVICE_SOURCES.application` beside `serverId`, which is one line each — and
 * wrong twice. Seven of the eight tables have no build-Server concept and no
 * source at all, so seven arms of the union would carry `null` literals to keep
 * the shapes equal; and the union's row type *is* `EnvironmentServiceSummary`,
 * which is served by `GET /environments/:id`, so a build-topology fact would
 * land in a display projection whose own docblock states it is "deliberately
 * uniform across the eight service types … a projection, not the service row".
 * A cascade's teardown target is not something an Environment read should have
 * to carry. So the facts are fetched where they are needed, in one extra select
 * that is skipped entirely when the tree holds no Applications — and the built-image
 * reclaim adds a **column to that select rather than a second select**, which is the whole
 * reason the first one was written to return a row rather than a scalar.
 */
export async function listCascadeChildren(
  db: DrizzleDB,
  environmentIds: string[],
): Promise<CascadeChild[]> {
  const services = await listServicesInEnvironments(db, environmentIds);
  const buildFacts = await applicationBuildFactsOf(
    db,
    services
      .filter((service) => service.serviceType === 'application')
      .map((service) => service.serviceId),
  );

  const runLogs = await runLogOwnersOf(db, services);
  const traced = await tracedServiceIdsOf(db, services);
  const aiModels = await aiModelIdsAmong(
    db,
    services
      .filter((service) => service.serviceType === 'application')
      .map((service) => service.serviceId),
  );

  return services.map((service) => {
    const facts = buildFacts.get(service.serviceId);
    return {
      serviceType: service.serviceType,
      serviceId: service.serviceId,
      appName: service.appName,
      serverId: service.serverId,
      // `?? null` and not `!`: a `Map` miss and a stored `null` are the same
      // answer here — no dedicated build Server — and `buildHostServerId` reads
      // both as "wherever the service runs".
      buildServerId: facts?.buildServerId ?? null,
      // A miss is `null` rather than a default source, and the difference
      // matters: `builtImageTag` reclaims `${appName}:latest` for every arm but
      // `'docker'`, so a guessed source is a `docker image rm` aimed at an
      // operator's own image. A miss means the Application row went between the
      // two selects, which means there is nothing to reclaim anyway.
      sourceType: facts?.sourceType ?? null,
      runLogs: runLogs
        .filter(({ serviceId }) => serviceId === service.serviceId)
        .map(({ appName, serverId }) => ({ appName, serverId })),
      traced: traced.has(service.serviceId),
      aiModel: aiModels.has(service.serviceId),
    };
  });
}

/**
 * What a cascade needs to know about each of these Applications beyond the
 * Environment read: which machine built it, and what it built from.
 *
 * One select for the whole cascade rather than one per child, on
 * {@link listServicesInEnvironments}'s reasoning: a Project with eleven
 * Applications would otherwise pay eleven round trips before it had started
 * asking Docker anything. An empty list is answered without touching the
 * database — `inArray` over an empty array is a query whose answer is known.
 *
 * `sourceType` joined the projection rather than arriving as a second
 * select, which is what makes the built-image reclamation cost this cascade no
 * extra round trip at all.
 */
async function applicationBuildFactsOf(
  db: DrizzleDB,
  applicationIds: string[],
): Promise<
  Map<string, { buildServerId: string | null; sourceType: SourceType }>
> {
  if (applicationIds.length === 0) return new Map();
  const rows = await db
    .select({
      applicationId: application.applicationId,
      buildServerId: application.buildServerId,
      sourceType: application.sourceType,
    })
    .from(application)
    .where(inArray(application.applicationId, applicationIds));
  return new Map(
    rows.map((row) => [
      row.applicationId,
      { buildServerId: row.buildServerId, sourceType: row.sourceType },
    ]),
  );
}

/**
 * Tears every child down and answers with the ones it could not confirm gone.
 *
 * One child at a time, and the N+1 round trips to the daemon are the accepted
 * cost of the fix: the only way to make them go away is to stop asking,
 * and not asking is precisely what turned a Project delete into a bulk orphan.
 * Sequential rather than concurrent because a Project's Services can sit on
 * several Servers, and fanning out would open an SSH connection per child on
 * each of them at once.
 *
 * Nothing here throws for a workload that survived. The verdict is data, so the
 * caller decides between a 409 and a forced delete without this file knowing
 * which of the two parents it is serving.
 *
 * **One settle deadline for the whole cascade, not a budget per child (H-105).**
 * A compose child's presence read is polled rather than taken once, because
 * `docker stack rm` returns when the daemon accepts the removal and the stack's
 * tasks keep answering `present` for 6–7 s afterwards — which is why
 * `ComposeService.remove` waits, and this file read immediately after
 * `composeTeardownCommand` exactly as `remove` used to. Giving each child its
 * own `COMPOSE_SETTLE_BUDGET_MS` would multiply the ceiling by the child count:
 * a Project with five stacks could hold one `DELETE` for 75 s, and the operator
 * has no way to know that a request which looks hung is merely polite.
 *
 * So the deadline is computed once, here, and each child gets whatever is left
 * of it. A child whose turn comes after it has passed is asked once, immediately
 * — precisely the read it got before this existed — and refuses on that answer.
 * The worst case therefore stays where it already was, the common case (one
 * stack still draining) is fixed, and nothing has to be decided about how long
 * a Project delete may block.
 *
 * The two properties the orphan fix and H-95 bought are unchanged, because
 * {@link awaitComposeWorkloadAbsent} owns them: a spent budget returns the
 * probe's own last answer, so it still **refuses** rather than assuming absence,
 * and `'unknown'` is never re-asked — an unreachable Server must not multiply an
 * SSH connect timeout by the poll count, and nothing about a dead transport
 * settles in fifteen seconds.
 */
export async function tearDownCascadeChildren(
  deps: CascadeDeleteDeps,
  children: readonly CascadeChild[],
): Promise<TeardownReport> {
  const orphaned: OrphanedWorkload[] = [];
  const unreclaimedArtifacts: UnreclaimedArtifact[] = [];
  const clock = deps.settleClock ?? systemSettleClock;
  const settleDeadline = clock.now() + COMPOSE_SETTLE_BUDGET_MS;
  for (const child of children) {
    // Best-effort per step, and what a failed step left is now part of the
    // answer rather than only the presence read's business —
    // `common/teardown-steps.ts` carries both halves and the reason the
    // Traefik config is the step that needs the first.
    unreclaimedArtifacts.push(
      ...(await runTeardownSteps(teardownStepsFor(deps, child))),
    );
    const presence = await presenceOf(
      deps,
      child,
      Math.max(0, settleDeadline - clock.now()),
    );
    if (presence !== 'absent') {
      orphaned.push({
        appName: child.appName,
        serverId: child.serverId,
        reason: presence,
      });
    }
  }
  return { orphaned, unreclaimedArtifacts };
}

/**
 * The 409's message. It names every workload the refusal is protecting rather
 * than a count, because the operator's next action is per workload — stop that
 * Service, or go and look at that Server — and a count tells them neither.
 * Shaped like the per-Service refusals in `applications.service.ts` and
 * `compose.service.ts` so the three read as one contract.
 *
 * **Two numbers that agree independently (X12-4a).** This used to have no
 * singular anywhere, so a Project holding one Service that survived read
 * *"1 of the 1 Services … stop them"* — wrong twice in one sentence, on the
 * commonest cascade shape there is, and against the very contract the paragraph
 * above claims: `applications.service.ts` and `database-service.ts` both say
 * "stop it", and `servers.service.ts`'s `nameCategory` has pluralized on
 * `found.length === 1 ? one : many` for a long time.
 *
 * The noun in the count clause agrees with `total`; the action agrees with
 * `orphaned.length`. They are not the same number — one orphan out of five is
 * "1 of the 5 Services … stop it" — so they are two branches, not one.
 *
 * `orphaned.length <= total` structurally: {@link tearDownCascadeChildren}
 * pushes at most one entry per child and {@link cascadeDelete} passes that same
 * array's `children.length`. So "2 of the 1" is unreachable and only `total`'s
 * singular needs a form.
 *
 * That form restructures rather than fixing the noun in place: `1 of the 1
 * Service` agrees correctly and is still a tautology nobody writes. Where there
 * is one Service and it is the one that survived, "the only Service" is what
 * the sentence means. `X of the Y` is kept everywhere else — `2 of the 2` is
 * real, and `3 of the 3` was read off the box in X08 — so this is not a general
 * collapse of the `X === Y` case. All four shapes are pinned whole-string in
 * `test/common/service-cascade.spec.ts`.
 */
export function cascadeRefusalMessage(
  parent: { kind: 'Project' | 'Environment'; name: string },
  orphaned: readonly OrphanedWorkload[],
  total: number,
): string {
  const names = orphaned.map((workload) => workload.appName).join(', ');
  const subject =
    total === 1
      ? `The only Service under ${parent.kind} ${parent.name}`
      : `${orphaned.length} of the ${total} Services under ${parent.kind} ${parent.name}`;
  const stop = orphaned.length === 1 ? 'stop it' : 'stop them';
  return `${subject} could not be confirmed gone, so the ${parent.kind} was kept: deleting it would leave ${names} unreachable through Cloudgate — ${stop}, then delete again, or delete with ?force=true`;
}

/**
 * Delete, for a Project or an Environment: the whole sequence, in one place.
 *
 * The two roots ran an identical six steps — authorize every child, tear them
 * all down, refuse if any survived, drop the row, name what was left behind —
 * differing only in which table the row comes out of and which word the
 * refusal uses. That is two copies of the rule this module exists to state, and
 * the failure mode if they drift is not cosmetic: the halves that could quietly
 * diverge are *the per-child permission gate* and *the refusal*, so one root
 * silently losing a step is a cross-tenant orphan or an unauthorized teardown,
 * which is the platform-container bug reopening itself. `isPlatformContainerName` is the same
 * argument one module over — a listing and a gate written twice are how they
 * came to disagree in the first place.
 *
 * What is parameterized is only what genuinely differs. `authorizeChild` is a
 * callback rather than a `PermissionCtx` because the check belongs to the
 * service that owns the `PermissionService`, and this module deliberately takes
 * its collaborators as `import type` (see {@link CascadeDeps}); `deleteRow` is
 * a thunk for the same reason — the Drizzle statement names a table this module
 * has no business importing. `reclaimPreserved` is the third, and needs both of
 * those: the `rollback` rows it reads are behind a `DrizzleDB` and the
 * `checkServerAccess` beside them is behind a `PermissionCtx`.
 *
 * **`reclaimPreserved` and `tearDownPreviews` are required rather than
 * optional, and that is the same decision as `teardownStepsFor`'s exhaustive
 * switch.** A third root that forgot to pass one would cascade with no
 * reclamation at all and nothing would say so — which is the failure mode this
 * whole module exists to close, one resource along. Both existing roots pass
 * the same two one-liners.
 *
 * **The order is the point and is not a caller's choice.** Authorization
 * precedes the first exec, so a caller refused a child never reaches the
 * daemon; the previews and the images are reclaimed after the refusal, so a
 * kept tree keeps its running previews and its restorable snapshots; the row is
 * dropped last, so a refusal leaves the whole tree intact — and so the
 * `preview_deployment` and `rollback` rows are still there to be read.
 */
export async function cascadeDelete<TRow extends object>({
  deps: rootDeps,
  children,
  parent,
  force,
  authorizeChild,
  reclaimPreserved,
  tearDownPreviews,
  bucketFiles,
  deleteRow,
}: {
  deps: CascadeDeps;
  children: readonly CascadeChild[];
  parent: { kind: 'Project' | 'Environment'; name: string };
  /** The `?force=true` escape hatch: delete anyway, and say what survived. */
  force: boolean;
  authorizeChild: (child: CascadeChild) => Promise<void>;
  /**
   * Drops the preserved rollback images of the Applications in this cascade and
   * answers with what it could not — `rollbacks/preserved-images.ts`'s
   * `reclaimPreservedImages`, which every caller passes over
   * {@link applicationIdsOf}`(children)`.
   *
   * It is handed the Delete's exec layer, and must dial through it, so a
   * Server the teardown could not reach is not dialled again.
   */
  reclaimPreserved: (
    remoteExec: RemoteExecService,
    release: ImageRelease,
  ) => Promise<UnreclaimedImages[]>;
  /**
   * Tears down the preview deployments of the Applications in this cascade and
   * answers with the ones it could not confirm gone —
   * `preview-deployments/preview-teardown.ts`'s
   * `tearDownApplicationPreviews`, which every caller passes over the same
   * {@link applicationIdsOf}`(children)`.
   *
   * A second callback beside `reclaimPreserved` rather than a bundle, because
   * they are two artifacts with two owners and each is named for what it does.
   * If a third ever joins them, the pair should collapse into a `db` and a
   * `PermissionCtx` on {@link CascadeDeps} and this file should call all three
   * itself — at three the "a root might forget one" risk the required
   * parameters exist to close is better closed by there being nothing to pass.
   *
   * Handed the Delete's exec layer for `reclaimPreserved`'s reason.
   */
  tearDownPreviews: (remoteExec: RemoteExecService) => Promise<TeardownReport>;
  /**
   * Reads whether each of these buckets holds files —
   * `BucketDeletes.cascadeFiles`, which every caller passes. Called before the
   * teardown, while each bucket's Garage still answers; its `settle` runs
   * after the refusal, removing each empty bucket's volume and naming the
   * rest. Never asked to delete a file: no Environment or Project Delete
   * offers that.
   */
  bucketFiles: (bucketIds: readonly string[]) => Promise<BucketCascade>;
  deleteRow: () => Promise<TRow>;
}): Promise<CascadeDeleted<TRow>> {
  // Every child, before the first exec — or the route is both a way to destroy
  // Services the caller may not touch and a way to make Docker calls they are
  // not entitled to.
  for (const child of children) {
    await authorizeChild(child);
  }

  // One memo for the whole tree, so a Server the first child could not reach
  // is not dialled again by any later step, child or reclamation.
  const deps: CascadeDeleteDeps = {
    ...rootDeps,
    remoteExec: new ReachabilityMemo(rootDeps.remoteExec),
  };
  // Each bucket's files, read while its Garage still runs.
  const buckets = await bucketFiles(
    children
      .filter((child) => child.serviceType === 'bucket')
      .map((child) => child.serviceId),
  );
  const { orphaned, unreclaimedArtifacts: childArtifacts } =
    await tearDownCascadeChildren(deps, children);
  if (orphaned.length > 0 && !force) {
    throw new ConflictException(
      cascadeRefusalMessage(parent, orphaned, children.length),
    );
  }

  // After the refusal and before the row, both of them: a reclamation ahead of
  // the 409 would leave a kept tree whose console still offers Rollback on
  // snapshots whose images are gone and whose previews' Swarm services have
  // been torn out from under their rows, and one after the delete has nothing
  // left to read. The previews go first, on `ApplicationsService.remove`'s
  // ordering: that arm drops containers and this one only disk.
  const previews = await tearDownPreviews(deps.remoteExec);
  // One wait for both image reclamations, so a container that outlasts it
  // costs the budget once per machine rather than once per reclamation. A
  // forced cascade past a child it could not confirm gone only untags: that
  // child's running container holds its image, and which images are its is
  // not known per machine here, so the whole cascade untags as before #1415
  // (`ImageRelease`).
  const imageRelease =
    orphaned.length === 0 ? awaitImageRelease() : 'untag-only';
  const unreclaimedPreserved = await reclaimPreserved(
    deps.remoteExec,
    imageRelease,
  );
  // And the patch-repo clones. Not a fourth callback: unlike the two
  // above it needs neither a `DrizzleDB` nor a `PermissionCtx` — the clone's
  // name is `child.appName` and its machine is `buildHostServerId(child)`, both
  // of which this file already holds — so the condition under which
  // `reclaimPreserved` and `tearDownPreviews` were to collapse into a `db` and
  // a `PermissionCtx` on `CascadeDeps` is not met by this third reclamation
  // arriving. A root cannot forget to pass what it never passes.
  // And the image each Application's build left on its build host. Not a
  // callback either, and for `reclaimApplicationPatchRepos`' reason: the tag is
  // derived from `child.appName` and `child.sourceType` and the machine from
  // `buildHostServerId(child)`, all of which this file already holds. It shares
  // `unreclaimedImages` with `reclaimPreserved` rather than adding a field or an
  // `UnreclaimedArtifact` `kind` — `common/teardown-steps.ts`'s
  // `UnreclaimedImages` carries that argument.
  const unreclaimedBuilt = await reclaimBuiltImages(
    deps.remoteExec,
    builtImageOwnersOf(children),
    imageRelease,
  );
  // One projection, two reclamations, and it is named for the
  // question rather than for the first caller that needed it: both of these
  // want `teardown-steps.ts`' `BuildHostArtifactOwner`, so this is built once
  // rather than twice.
  const buildHostOwners = buildHostArtifactOwnersOf(children);
  const unreclaimedRepos = await reclaimApplicationPatchRepos(
    deps.remoteExec,
    buildHostOwners,
  );
  // And the artifacts a *killed* build left on each build host — the
  // railpack buildx builder and the nixpacks copy-out container that the
  // next-build reclaims only bound. Here as well as in `ApplicationsService.remove`
  // because doing it in one and not the other is where a rule drifts rather
  // than where it holds, which is ADR-0018's own argument about a Compose
  // stack's clone.
  //
  // Nothing is merged into either report, and `applications/build-leftovers.ts`
  // argues why: neither name is a `path` and neither is an image reference, and
  // a *sweep* exits 0 whether it matched nothing or everything, so a failure of
  // it says "the sweep did not run" rather than naming an artifact left behind.
  await reclaimBuildLeftovers(deps.remoteExec, buildHostOwners);
  // And the `files` half of each child's tree, on the **run** Server.
  // Every `rm -rf` above it names the build host, which is where the
  // `code` half is; `MountsService` writes the file mounts to
  // `parent.serverId`, so on a dedicated-build-Server install nothing had ever
  // removed an Application's. A managed database's was worse and is the half
  // closed here: its only teardown is `removeDatabaseService`, so there was no
  // `rm -rf` to be aimed at the wrong machine and the tree leaked on every
  // install. `fileMountOwnersOf` carries which children answer here and why the
  // set is stated as the writer's own fork negated. Not a callback and not a
  // fourth entry in `teardownStepsFor`, and the second of those is the
  // decision: `common/teardown-steps.ts` carries why a tree nothing
  // re-materializes may not be removed ahead of the refusal above.
  const unreclaimedFileMounts = await reclaimFileMounts(
    deps.remoteExec,
    fileMountOwnersOf(children),
  );
  // And each traced child's Trace store, on its run Server. Not a
  // callback, for `reclaimApplicationPatchRepos`' reason: whether a child has
  // one was read with the children (`CascadeChild.traced`), and the rest is
  // its `appName` and `serverId`, which this file already holds.
  const unreclaimedTraceStores = await removeTraceStores(
    deps.remoteExec,
    traceStoreOwnersOf(children),
  );
  // And each Application's and Compose's own directory, after the
  // Trace stores and file mounts it is the parent of — see
  // `reclaimServiceDirectories` for why not before the refusal.
  const unreclaimedDirectories = await reclaimServiceDirectories(
    deps.remoteExec,
    children,
  );
  const unreclaimedLogs = await reclaimDeploymentLogs(
    deps.remoteExec,
    deploymentLogOwnersOf(children),
  );
  // And each AI model's weights volume, always, as
  // `ApplicationsService.remove` does: last, so the steps above are time its
  // task spends letting go of it. A child the 409 was forced past keeps its.
  const unreclaimedWeights = await reclaimWeightsVolumes(
    deps.remoteExec,
    weightsVolumeOwnersOf(children, orphaned),
  );
  // The children's own artifacts first, then the previews' trees, then the
  // clones, then the file-mounts trees, the Trace stores, the children's
  // directories, their logs and the weights volumes, which is the order they
  // were attempted in; a preview's directory sits beside its parent's under
  // the applications tree and is reclaimed by the same rule.
  const unreclaimedArtifacts = [
    ...childArtifacts,
    ...previews.unreclaimedArtifacts,
    ...unreclaimedRepos,
    ...unreclaimedFileMounts,
    ...unreclaimedTraceStores,
    ...unreclaimedDirectories,
    ...unreclaimedLogs,
    ...unreclaimedWeights,
  ];

  // The preserved snapshot tags first, then the built tags, which is the order
  // they were attempted in. One array because they are one claim — images this
  // delete could not reclaim, per machine — and a machine can appear in both if
  // both reclamations failed on it, which is two truths rather than a
  // duplicate.
  const unreclaimedImages = [...unreclaimedPreserved, ...unreclaimedBuilt];

  // Each bucket's volume, after the refusal like every reclamation here: an
  // empty bucket's goes, and every other bucket is named as kept.
  const bucketsLeftBehind = await buckets.settle(deps.remoteExec);

  const removed = await deleteRow();
  // Absent rather than empty: a bare `orphaned: []` on every healthy delete
  // would make the field mean "this route can orphan things" instead of "these
  // were left behind". `unreclaimedImages`, `orphanedPreviews` and
  // `unreclaimedArtifacts` follow the same rule.
  if (
    orphaned.length === 0 &&
    unreclaimedImages.length === 0 &&
    previews.orphaned.length === 0 &&
    unreclaimedArtifacts.length === 0 &&
    bucketsLeftBehind.length === 0
  ) {
    return removed;
  }
  return {
    ...removed,
    ...(orphaned.length > 0 ? { orphaned } : {}),
    ...(unreclaimedImages.length > 0 ? { unreclaimedImages } : {}),
    ...(previews.orphaned.length > 0
      ? { orphanedPreviews: previews.orphaned }
      : {}),
    ...(unreclaimedArtifacts.length > 0 ? { unreclaimedArtifacts } : {}),
    ...(bucketsLeftBehind.length > 0 ? { bucketsLeftBehind } : {}),
  };
}

/**
 * The `applicationId`s in a cascade — what `reclaimPreservedImages` and
 * `tearDownApplicationPreviews` are asked about.
 *
 * Here rather than in each root for `listCascadeChildren`'s reason: the filter
 * is *which of these children can carry a preserved rollback image*, and only
 * the Application arm can — `compose` has no build-Server concept at all
 * (`DeploymentsService.findCompose` hard-codes `buildServerId: null`) and no
 * database engine captures snapshots. A root writing the predicate itself would
 * be a second place for the answer to drift when a ninth engine gains
 * rollbacks. `CascadeChild.serviceId` is the Application's own id, which is
 * what `listCascadeChildren` reads out of `listServicesInEnvironments`.
 *
 * The same predicate answers for previews for the same reason:
 * `preview_deployment.applicationId` is a foreign key into `application` and no
 * other table has one, so a preview can only ever hang off this arm.
 */
export function applicationIdsOf(children: readonly CascadeChild[]): string[] {
  return children
    .filter((child) => child.serviceType === 'application')
    .map((child) => child.serviceId);
}

/**
 * The Application children whose build-host artifacts this cascade is about to
 * make unnameable, in the shape every reclamation of one takes.
 *
 * **This was `patchRepoOwnersOf` and answered for two callers under one
 * caller's name.** It was written for `reclaimApplicationPatchRepos`; a later change gave
 * the cascade `reclaimBuildLeftovers` and passed it *this* projection under a
 * comment apologising for the borrowing — *"it takes `patchRepoOwnersOf`'s
 * projection rather than a fourth of its own"*. The projection was right and
 * the name was wrong, which is the half of the owner-type data clump that lives here:
 * both reclamations want `common/teardown-steps.ts`' {@link
 * BuildHostArtifactOwner}, the `appName` that names the artifact and the two
 * ids `buildHostServerId` resolves, and that is now what this is called and
 * what it returns. `builtImageOwnersOf` stays separate because
 * `BuiltImageOwner` needs a fourth column this projection deliberately does not
 * carry.
 *
 * The Application arm only, and that is a scope rather than the predicate above
 * being reused for a third artifact by accident: a Compose stack has a clone
 * too — the tree is `{patchReposDirectory()}/{application|compose}/{appName}` —
 * but `ComposeService.remove` does not reclaim it, and reclaiming it *here*
 * would mean a stack's clone was reclaimed when its Project was deleted and not
 * when the stack itself was. That is where a rule drifts rather than where it
 * holds, which is the argument ADR-0018 makes about a refusal one table along.
 * Named in ADR-0018's non-goal list instead. The build-leftover sweep is scoped
 * by the same predicate for a different reason: a Compose stack's build leaves
 * neither a railpack builder nor a nixpacks copy-out container, because
 * `docker compose build` is not one of the four builders.
 *
 * Ids come straight off `CascadeChild` rather than out of a second select, for
 * the reason it carries `buildServerId` at all: `listCascadeChildren` already
 * paid for that column, and both artifacts want the same two answers — the
 * `appName` that names them and the build host that holds them — as the source
 * tree beside them.
 */
export function buildHostArtifactOwnersOf(
  children: readonly CascadeChild[],
): BuildHostArtifactOwner[] {
  return children
    .filter((child) => child.serviceType === 'application')
    .map(({ appName, serverId, buildServerId }) => ({
      appName,
      serverId,
      buildServerId,
    }));
}

/**
 * The children whose **run**-Server file-mounts tree this cascade is about to
 * make unnameable, in the shape {@link reclaimFileMounts} takes.
 *
 * **A projection of its own rather than {@link buildHostArtifactOwnersOf}'s,
 * even though that one already carries both columns.** It does, and handing it
 * over would compile — which is exactly the complaint about three
 * structurally identical owner types checking nothing. The difference here is
 * not structural but in what the field *means to the caller*: on that type
 * `serverId` is one of the two **inputs** {@link buildHostServerId} resolves,
 * and every reclamation taking it asks that question; this one must never ask
 * it, because a bind-mount source is a path in the mounting host's filesystem
 * and the machine that holds it is the runner. So the two are named for the two
 * questions and neither reads as the other's leftover. A managed database makes
 * that sharper rather than muddier: it has no build-Server concept at all, so
 * `serverId` is the only machine it has.
 *
 * **The filter is the writer's own fork, negated, and that is the whole design.**
 * `MountsService.baseFilesPath` branches on exactly one
 * `serviceType`: `'compose'` gets the stack's project tree and *everything
 * else* gets `fileMountsDirectoryOnRunServer` — an Application and all six
 * managed-database types alike (`serviceTypeEnum` binds eight values, of which
 * `'application'` and `'compose'` are the two that are not a database). So the
 * destroyer asks the complement of the same one question rather than listing
 * the seven arms it covers. Listing them is what an earlier fix did, and it left the
 * databases leaking on **every** install — `removeDatabaseService` drops the
 * Swarm service and no `rm -rf` followed it anywhere in `src/databases/`, so
 * the row cascaded and `mount.content` stayed on disk in plaintext. A list
 * would also have to be edited again the day a ninth engine is registered,
 * which writes file mounts from its first deploy because the writer's default
 * arm already answers for it; a negation cannot fall behind that way. It costs
 * the exhaustiveness a `switch` would give, and that trade is deliberate: an
 * unlisted engine here leaks a credential file, an unlisted engine in
 * {@link teardownStepsFor} leaves a workload running, and only one of those two
 * is better off failing closed.
 *
 * A **Compose stack needs nothing**, which is why it is the value excluded
 * rather than an arm that reclaims: its file mounts sit at
 * `{composeDirectoryOn(serverId)}/{appName}/files`, inside the project tree
 * {@link reclaimServiceDirectories} `rm -rf`s, on the one Server a stack has
 * (`findCompose` hard-codes `buildServerId: null`). An entry for it would
 * remove a subtree of one already being removed and, on a failure, report an
 * {@link UnreclaimedArtifact} for a directory that reclamation already names.
 *
 * `BaseDatabaseService.remove` gained the same reclamation in the same change
 * and had to: reclaiming a database's file mounts on a **Project**
 * delete and not on the **database's own** is ADR-0018's drift rather than a
 * partial fix.
 */
export function fileMountOwnersOf(
  children: readonly CascadeChild[],
): { appName: string; serverId: string | null }[] {
  return children
    .filter((child) => child.serviceType !== 'compose')
    .map(({ appName, serverId }) => ({ appName, serverId }));
}

/**
 * Drops each Application's and each Compose stack's own directory, and answers
 * with the ones it could not.
 *
 * **After the refusal, and that is the whole of the change.** Both used to be
 * teardown steps — the Application's `removeApplicationDirectoryStep` in
 * {@link teardownStepsFor}, the Compose's the last statement of
 * `composeTeardownCommand` — so they ran ahead of the presence read, and a
 * refused cascade had already erased every child's tree. On a single-Server
 * install that tree is the parent of the child's file mounts and its Trace
 * store's data, which the reclamations beside this one wait for the refusal to
 * protect, and nothing regenerates either. So a 409 leaves every child's tree
 * intact, `code/` included: removing the clone early saves nothing, and one
 * rule is simpler to hold than a carve-out.
 *
 * The same two helpers `ApplicationsService.remove` and `ComposeService.remove`
 * run, `reclaimApplicationDirectory` and `reclaimComposeDirectory` — the
 * Application's on its build host ({@link buildHostServerId}) under that
 * host's own root, the stack's on its one Server — so a Project
 * delete and a Service delete leave the same thing behind. Databases have no
 * directory of their own.
 */
export async function reclaimServiceDirectories(
  remoteExec: RemoteExecService,
  children: readonly CascadeChild[],
): Promise<UnreclaimedArtifact[]> {
  const unreclaimed: UnreclaimedArtifact[] = [];
  for (const child of children) {
    if (child.serviceType === 'application') {
      unreclaimed.push(
        ...(await reclaimApplicationDirectory(remoteExec, child)),
      );
    } else if (child.serviceType === 'compose') {
      unreclaimed.push(...(await reclaimComposeDirectory(remoteExec, child)));
    }
  }
  return unreclaimed;
}

/**
 * The AI models among the children, whose weights volumes this cascade
 * reclaims, each on its run Server. One whose Swarm service survived
 * a forced cascade is not confirmed gone, so its volume is kept and said so.
 */
export function weightsVolumeOwnersOf(
  children: readonly CascadeChild[],
  orphaned: readonly OrphanedWorkload[],
): WeightsVolumeOwner[] {
  return children
    .filter((child) => child.aiModel)
    .map(({ appName, serverId }) => ({
      appName,
      serverId,
      serviceGone: !orphaned.some(
        (o) => o.appName === appName && o.serverId === serverId,
      ),
    }));
}

/**
 * The children whose Trace store this cascade reclaims: the traced
 * ones, on their run Servers. `CascadeChild.traced` is only ever true for an
 * Application or a Compose, the two kinds a `trace_store` row can name.
 */
export function traceStoreOwnersOf(
  children: readonly CascadeChild[],
): Pick<TraceStoreOwner, 'serviceType' | 'appName' | 'serverId'>[] {
  return children
    .filter((child) => child.traced && isTraceServiceType(child.serviceType))
    .map(({ serviceType, appName, serverId }) => ({
      serviceType: serviceType as TraceServiceType,
      appName,
      serverId,
    }));
}

/**
 * The children whose deployment-log directory this cascade is about to make
 * unnameable, on the machine `DeploymentsService.initializeLog` wrote
 * it to: {@link buildHostServerId}'s answer for an Application, the one
 * machine a Compose stack has (`findCompose` hard-codes `buildServerId:
 * null`). A database writes no Deployment of its own. Every child also brings
 * the directories of the run records it cascades away
 * ({@link CascadeChild.runLogs}), on its run Server.
 *
 * The same arms `ApplicationsService.remove`, `ComposeService.remove` and
 * `BaseDatabaseService.remove` reclaim, so a Project delete and a Service
 * delete leave the same thing behind — the drift ADR-0018 warns about one
 * table along.
 */
export function deploymentLogOwnersOf(
  children: readonly CascadeChild[],
): { appName: string; serverId: string | null }[] {
  return children.flatMap((child) => {
    switch (child.serviceType) {
      case 'application':
        return [
          { appName: child.appName, serverId: buildHostServerId(child) },
          ...child.runLogs,
        ];
      case 'compose':
        return [
          { appName: child.appName, serverId: child.serverId },
          ...child.runLogs,
        ];
      default:
        return [...child.runLogs];
    }
  });
}

/**
 * The Application children whose built image this cascade is about to make
 * unnameable, in the shape `reclaimBuiltImages` takes.
 *
 * The Application arm only, and here that is not merely a scope but the whole
 * of the safety: no other `serviceType` produces a `${appName}:latest` at all —
 * a Compose stack's images are named by its own compose file and a managed
 * database runs an upstream image it pulled — so a predicate any wider would
 * aim `docker image rm` at a tag this platform did not create.
 *
 * A child with no `sourceType` is dropped rather than defaulted: see
 * {@link CascadeChild.sourceType}. `builtImageTag` then drops the `'docker'`
 * arm, which is the same rule stated where the tag is derived rather than here,
 * so the two cannot disagree.
 */
export function builtImageOwnersOf(
  children: readonly CascadeChild[],
): BuiltImageOwner[] {
  return children.flatMap((child) =>
    child.serviceType === 'application' && child.sourceType
      ? [
          {
            appName: child.appName,
            sourceType: child.sourceType,
            serverId: child.serverId,
            buildServerId: child.buildServerId,
          },
        ]
      : [],
  );
}
