import { Inject, Injectable, Logger } from '@nestjs/common';
import { checkServerAccess } from '../common/owned-server';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { PermissionCtx } from '../rbac/permission.service';
import { PermissionService } from '../rbac/permission.service';
import {
  ContainerAccessService,
  isPlatformContainerName,
  OWNER_LABELS,
} from '../realtime/container-access.service';
import type { ServiceAddress } from '../realtime/container-access.service';
import { execOnServer } from '../remote/exec-dispatch';
import { RemoteExecService } from '../remote/remote-exec.service';
import type { ExecResult } from '../remote/remote-exec.service';
import { refuseWhileInMaintenance } from '../servers/server-maintenance';
import { withoutOtlpHeaders } from '../traces/trace-store';
import { rethrowIfHostUnreachable } from './host-reachability';

/** A container-targeting mutation: which container, on which server. */
export interface ContainerOpInput {
  containerId: string;
  serverId?: string | null;
}

/**
 * The prefix the listing's `--format` writes each owner label under.
 *
 * A `Record` over `OWNER_LABELS` rather than a free literal, so a fourth label
 * added to the definition of a **managed container**
 * (`realtime/container-access.service.ts`) is a type error here instead of a
 * column the listing silently stops filtering on.
 */
const OWNER_LABEL_PREFIX: Record<(typeof OWNER_LABELS)[number], string> = {
  'com.docker.swarm.service.name': 'Swarm',
  'com.docker.compose.project': 'Compose',
  'com.docker.stack.namespace': 'Stack',
};

/**
 * The owner label `GET /docker/containers/search` filters on, per `appType`.
 * An absent `appType` is an Application or a database, whose
 * containers are the tasks of a Swarm service named its `appName`. Each is one
 * of `OWNER_LABELS`, so the listing matches on exactly what the container gate
 * resolves a Service by.
 */
const APP_TYPE_LABEL: Record<
  'stack' | 'docker-compose',
  (typeof OWNER_LABELS)[number]
> = {
  stack: 'com.docker.stack.namespace',
  'docker-compose': 'com.docker.compose.project',
};
const SWARM_SERVICE_LABEL: (typeof OWNER_LABELS)[number] =
  'com.docker.swarm.service.name';

/** Six container fields, then one field per owner label, in that order. */
const CONTAINER_LIST_FIELDS = [
  'CONTAINER ID : {{.ID}}',
  'Name: {{.Names}}',
  'Image: {{.Image}}',
  'Ports: {{.Ports}}',
  'State: {{.State}}',
  'Status: {{.Status}}',
  ...OWNER_LABELS.map(
    (label) => `${OWNER_LABEL_PREFIX[label]}: {{.Label "${label}"}}`,
  ),
];

/**
 * The `docker ps -a` listing plus the owner labels the managed filter reads.
 *
 * `.Label` is a documented `docker ps --format` placeholder, so the three cost
 * no second exec — and their values are Docker object names, which cannot
 * contain the ` | ` the parser splits on. An absent label renders empty rather
 * than as a Go template's `<no value>`, because `docker ps` resolves `.Label`
 * itself instead of indexing a map.
 */
const CONTAINER_LIST_COMMAND = `docker ps -a --format '${CONTAINER_LIST_FIELDS.join(' | ')}'`;

/** Where the owner-label fields start in a parsed row. */
const OWNER_LABEL_OFFSET = CONTAINER_LIST_FIELDS.length - OWNER_LABELS.length;

/**
 * The Service-scoped listing's `--format`: id, name, state, then the
 * two labels a Compose stack's service is named by. `|` separates them
 * because none of the five can contain one — two Docker object names, a state
 * enum and two label values Docker composes from object names.
 */
const SERVICE_CONTAINER_FORMAT =
  '{{.ID}}|{{.Names}}|{{.State}}|{{.Label "com.docker.compose.service"}}|{{.Label "com.docker.swarm.service.name"}}';

/** One running container of a Service, as the Shell tab's picker lists it. */
export interface ServiceContainer {
  containerId: string;
  name: string;
  state: string;
  /** A Compose stack's service this container runs; absent for any other kind. */
  composeService?: string;
}

/** One row of the `docker ps -a` listing. */
export interface ContainerListItem {
  containerId: string;
  name: string;
  image: string;
  ports: string;
  state: string;
  status: string;
  serverId: string | null | undefined;
}

/**
 * Operational container endpoints: everything shells out to the docker CLI
 * (locally or over SSH by serverId) and parses the --format output.
 *
 * The `containerId` and `appName` words interpolated below — `docker inspect`,
 * the `docker ps --filter` listings, the `docker stack ps` /
 * `docker service ps` prefix and `containerOp`'s verb — go in unquoted, and
 * that is only safe because every DTO in front of them holds the value to
 * `containerIdRegex` (`dto/docker-ops.dto.ts`). An earlier fix made that regex
 * load-bearing for these six sites without saying so anywhere near them, so it
 * is said here: loosening it is a shell-injection change, not a validation
 * tweak. The upload path is separate — it has its own in-method
 * allowlists, documented at `uploadFileToContainer`.
 *
 * **Every reader here used to swallow its errors, and a swallow cannot tell
 * "the host said nothing is running" from "nobody reached the host"** (X11-4).
 * Each catch now runs `rethrowIfHostUnreachable` first — as does the container
 * gate's — so a transport failure is a 503 naming itself and
 * everything else keeps the `[]` or `undefined` it had — `host-reachability.ts`
 * carries the argument, including why this is a status rather than a field on
 * the payload. `getConfig` is the one reader deliberately left out, and says
 * why on itself.
 */
/**
 * A container's inspect with a traced Service's ingest credential taken out of
 * its `Config.Env`: a deploy hands the credential to the container in
 * `OTEL_EXPORTER_OTLP_HEADERS`, and the spec says it never appears in any
 * response. Everything else the inspect says is answered as it was.
 */
function withoutTraceCredential(inspect: unknown): unknown {
  const config = (inspect as { Config?: { Env?: unknown } } | null)?.Config;
  if (!config || !Array.isArray(config.Env)) return inspect;
  return {
    ...(inspect as object),
    Config: { ...config, Env: withoutOtlpHeaders(config.Env as string[]) },
  };
}

@Injectable()
export class DockerOpsService {
  private readonly logger = new Logger(DockerOpsService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
    private readonly remoteExec: RemoteExecService,
    private readonly containerAccess: ContainerAccessService,
  ) {}

  /**
   * Parses `docker ps -a` into DTOs, hiding the platform's own containers (a
   * name containing `cloudgate`) except the monitoring one. Output on stderr
   * answers `undefined`; **errors used to answer `[]` and no longer do**
   * (X11-4, see the catch).
   *
   * **And hiding another organization's managed containers.** Both gates
   * above this line are machine-level: `docker: ['read']` is an org capability
   * that owner, admin and the enterprise base role all hold, and
   * `checkServerAccess` is a no-op for the platform host by design (ADR-0008) —
   * which is the daemon every organization's services share. So an owner of one
   * organization was handed every other organization's Swarm task name (its
   * `appName`), image, published ports, state and container id, and the
   * container routes act on exactly those ids.
   *
   * A row is dropped when its owner labels name a Service in another
   * organization. A row resolving to nothing is an **unmanaged** container —
   * Traefik, an operator's own — and is reached through machine-level Docker
   * access per CONTEXT.md, which is what the console panel says out loud; a row
   * resolving into the caller's own organization stays untouched.
   *
   * **And dropped when it is unmanaged on the platform host and the caller does
   * not administer this instance.** That sentence above is what kept the
   * unmanaged rows — *they are reached through machine-level Docker access* —
   * and the platform-host gate made it false for one machine: it gave an unmanaged container on
   * the platform host a second gate in
   * `ContainerAccessService.authorizeAppNames` and left this listing on the
   * `docker` statement alone, so the response offered rows carrying the image,
   * the published ports, the state and the **container id** the container routes act
   * on, and those routes then answered `CONTAINER_DENIAL_MESSAGE` for every one
   * of them. That is the disagreement the managed filter exists to prevent, so this asks the
   * acting side's own predicate — `hasMachineAuthority` — rather than growing a
   * second copy of the rule, which is how the listing and the acting came apart
   * the first time. ADR-0013 carries the decision and what it costs.
   *
   * **Two questions, and each is asked in the shape its own answer has.**
   * *Which machine, and do you administer it* cannot differ between rows of one
   * listing — `ownedServerId` resolves `serverId` once — so `hasMachineAuthority`
   * is asked once for the whole response. *Is this row unmanaged* does differ per
   * row, and it is asked **by resolution and not by label**, through
   * `unownedAppNames`, beside `foreignAppNames` and over the same set. Filtering
   * on the parsed `owners` array instead would have been a second, narrower copy
   * of the acting path's test: a container an operator started with
   * `docker compose -p my-monitoring up` carries an owner label the parse counts
   * and names no Service the database has, so it would have stayed listed while
   * `authorizeAppNames` sent its id to the machine branch and refused it — the
   * defect surviving inside its own fix.
   *
   * **Three callers reach this route and only one of them is a Server's tab.**
   * `monitoring/live-card.tsx` asks for the platform host by construction and
   * puts every running row into the live-stats picker, whose socket
   * already refused for these same containers — so the narrowing is what makes
   * the picker stop offering what `/listen-docker-stats-monitoring` will not
   * sample. `compose/containers/use-stack-containers.ts` also reaches the host,
   * for a stack deployed there, and is unaffected: it reads this route for the
   * Image and Ports columns alone and looks each row up **by container id**
   * against `containers/search`, so the only rows it can consume belong to its
   * own Compose — which has a Service row, resolves, and is never what this
   * drops.
   *
   * Deliberately *not* `checkServiceAccess` per row: owner and admin skip the
   * row-level check anyway, a base member never reaches the route, and for a
   * custom role it would interact with a known gap (nothing can write
   * `accessedServices`) to answer an empty list. Per-Service narrowing inside
   * one's own organization is a separate decision.
   */
  async getContainers(
    ctx: PermissionCtx,
    query: { serverId?: string | null },
  ): Promise<ContainerListItem[] | undefined> {
    await this.permissions.checkPermission(ctx, { docker: ['read'] });
    const serverId = await this.ownedServerId(ctx, query.serverId);
    // Outside the try, so a database that will not answer this is a failure
    // rather than the `undefined` the catch below means by "docker would not
    // say" — and `hasMachineAuthority` only swallows a refusal, never a failed
    // read.
    const unmanagedVisible = await this.containerAccess.hasMachineAuthority(
      ctx,
      serverId,
    );
    try {
      const { stdout, stderr } = await this.exec(
        serverId,
        CONTAINER_LIST_COMMAND,
      );
      if (stderr) {
        this.logger.error(`Error: ${stderr}`);
        return;
      }

      // Deliberately not `stdout.trim().split('\n')`. The format's last
      // field is an owner label, which renders as `"Stack: "` — trailing space,
      // no value — for a container carrying none, and `trim()` strips that space
      // off the **final line only**. The final line is the platform's own
      // container on every real box (`docker ps -a` is newest-first and Traefik
      // is created at install), and a field one byte short of its own prefix
      // parsed as a *phantom owner*, which took the row past the platform
      // filter. Dropping blank lines instead is what `trim()` was for.
      const lines = stdout.split('\n').filter((line) => line.trim() !== '');

      const rows = lines
        .map((line) => {
          const parts = line.split(' | ');
          const containerId = parts[0]
            ? parts[0].replace('CONTAINER ID : ', '').trim()
            : 'No container id';
          const name = parts[1]
            ? parts[1].replace('Name: ', '').trim()
            : 'No container name';
          const image = parts[2]
            ? parts[2].replace('Image: ', '').trim()
            : 'No image';
          const ports = parts[3]
            ? parts[3].replace('Ports: ', '').trim()
            : 'No ports';
          const state = parts[4]
            ? parts[4].replace('State: ', '').trim()
            : 'No state';
          const status = parts[5]
            ? parts[5].replace('Status: ', '').trim()
            : 'No status';
          // Anchored, and tolerant of the separating space being absent.
          // `field.replace('Stack: ', '')` was neither: an unanchored
          // string `replace` matches anywhere, and — the part that leaked — it
          // returns the field *unchanged* when the prefix is not there, so an
          // owner field the parser did not recognise became an owner *name*.
          // A security filter reads this array, so the unrecognised field is
          // "no owner" rather than "an owner called `Stack:`": fail closed, and
          // the platform test downstream gets to run.
          const owners = OWNER_LABELS.map((label, index) => {
            const field = parts[OWNER_LABEL_OFFSET + index] ?? '';
            const prefix = `${OWNER_LABEL_PREFIX[label]}:`;
            return field.startsWith(prefix)
              ? field.slice(prefix.length).trim()
              : '';
          }).filter((value) => value !== '');
          return {
            container: {
              containerId,
              name,
              image,
              ports,
              state,
              status,
              serverId,
            },
            owners,
          };
        })
        // The same test the gate applies (the managed filter's stated purpose): a
        // `cloudgate-*` row is hidden because it is *ours*, which is only true
        // when no Service claims it. A member's Application called
        // `my-cloudgate-api` carries owner labels and belongs in the listing
        // like any other — the old test dropped it, and dropped
        // `cloudgate-traefik` from the instance owner's own listing while every
        // container route handed it over.
        .filter(
          ({ container, owners }) =>
            !(owners.length === 0 && isPlatformContainerName(container.name)),
        );

      // One resolution for the whole listing, over the union of every owner
      // label any surviving row carries — never one query per row, which is the
      // N+1 `projects.service.ts` names.
      const names = [...new Set(rows.flatMap(({ owners }) => owners))];
      const foreign = await this.containerAccess.foreignAppNames(ctx, names);

      // Asked **by resolution rather than by label** so it is the
      // same question `authorizeAppNames` answers: a row whose labels name no
      // Service anywhere is what that method sends to its machine branch, and on
      // the platform host that branch now takes instance authority. Asked only
      // when the answer can drop something, so the second resolution is paid by
      // the caller being narrowed and by nobody else.
      const unowned = unmanagedVisible
        ? new Set<string>()
        : await this.containerAccess.unownedAppNames(names, serverId);

      return rows
        .filter(({ owners }) => !owners.some((name) => foreign.has(name)))
        .filter(
          ({ owners }) =>
            unmanagedVisible || owners.some((name) => !unowned.has(name)),
        )
        .map(({ container }) => container);
    } catch (error) {
      // **A Server that was never reached is not a Server with nothing running
      // on it** (X11-4). `return []` here is what let
      // `?serverId=<a host at 127.0.0.1:1>` answer `200 []` in **28 ms** — no
      // SSH attempt could have completed — while the console's Docker tab told
      // an operator mid-incident *"Docker answered and there are no containers
      // on this host."* The failure was in the journal at `level:50` the whole
      // time. See {@link rethrowIfHostUnreachable} for why this is a status and
      // not a field.
      rethrowIfHostUnreachable(this.logger, serverId, error);
      this.logger.error(error);

      // `undefined`, not the `[]` this used to answer. Everything left here ran
      // and failed — `docker ps` exiting nonzero because the daemon is not
      // running is the common one — which is the same fact as the `stderr`
      // branch above, *docker would not say*, and this route already has a
      // state for it that the console renders as itself. `[]` was a reading
      // nobody took.
      return;
    }
  }

  /**
   * `docker inspect` parsed to the raw JSON document. Every failure — bad
   * container, stderr, unparsable output — is swallowed to undefined.
   *
   * The swallow now lives *behind* the ownership gate, which narrows it:
   * a container this caller may not reach — including one that cannot be
   * inspected at all — is a `ForbiddenException` rather than an `undefined`.
   * Keeping the swallow in front of the gate was the alternative and it is the
   * whole bug: `docker inspect` on someone else's container answers its env
   * vars, mounts and labels, and answering `undefined` for the refusal would
   * have meant refusing nothing.
   *
   * **Deliberately not given X11-4's reachability channel, and the reason is
   * that it would be dead code.** {@link authorizeManagedContainer} runs first
   * and shells out to a `docker inspect` of its own, and
   * `ContainerAccessService.resolveTarget`'s catch answers the refusal — so on
   * a Server that cannot be reached this route, the five lifecycle verbs and the
   * upload never arrive here at all. That refusal is a **503
   * `HOST_UNREACHABLE`** — `PLATFORM_HOST_UNREACHABLE` when the target is on
   * the platform host — rather than a 403 claiming the container is not
   * the caller's, which is what this paragraph used to record as filed and unfixed;
   * `resolveTarget` runs `rethrowIfHostUnreachable` before its
   * `ForbiddenException` and its docblock carries why that does not weaken
   * the one-denial rule. The conclusion here is unchanged either way: the gate is still what
   * answers, so a channel on this method would still be unreachable.
   */
  async getConfig(
    ctx: PermissionCtx,
    query: { containerId: string; serverId?: string | null },
  ): Promise<unknown> {
    await this.permissions.checkPermission(ctx, { docker: ['read'] });
    const serverId = await this.ownedServerId(ctx, query.serverId);
    await this.authorizeManagedContainer(ctx, query.containerId, serverId);
    try {
      // Argv: the container id is a route parameter, and `--format` is one word
      // to the program rather than a shell-quoted one.
      const { stdout, stderr } = await this.exec(serverId, [
        'docker',
        'inspect',
        query.containerId,
        '--format={{json .}}',
      ]);

      if (stderr) {
        this.logger.error(`Error: ${stderr}`);
        return;
      }

      return withoutTraceCredential(JSON.parse(stdout) as unknown);
    } catch {
      // An unknown container answers undefined.
    }
  }

  /**
   * The short `docker ps` listing narrowed to one app, **by an exact owner
   * label**: `com.docker.compose.project` for `docker-compose`,
   * `com.docker.stack.namespace` for `stack`, and
   * `com.docker.swarm.service.name` otherwise. It used to grep the name for
   * everything but compose — a *prefix* match, so `?appName=a` listed every
   * container whose name began with `a`, on the platform host. The label is
   * also what `ContainerAccessService` resolves a container to its Service by,
   * so what is listed is exactly what was authorized.
   *
   * **Gated on the Service the name resolves to** before anything runs
   * (`authorizeAppName`, ADR-0008 as extended). The route's own
   * `service:read` is an organization capability and `ownedServerId` answers
   * the platform host for an absent `serverId`, so neither says anything about
   * *this* Service; without the gate a base member of any organization listed
   * every organization's containers on the platform host.
   *
   * Every failure path answers `[]` except a host that was not reached, which
   * is a 503 since X11-4 (`host-reachability.ts`'s `isTransportFailure`). The
   * console has been waiting for that: the compose Containers panel renders
   * *"a Server that cannot be reached looks exactly like a stack with nothing
   * running — which is why this says so rather than showing an empty table"*.
   */
  async getContainersByOwnerLabel(
    ctx: PermissionCtx,
    query: {
      appName: string;
      appType?: 'stack' | 'docker-compose';
      serverId?: string | null;
    },
  ): Promise<Array<Record<string, string>>> {
    await this.permissions.checkPermission(ctx, { service: ['read'] });
    const serverId = await this.ownedServerId(ctx, query.serverId);
    await this.containerAccess.authorizeAppName(ctx, query.appName, serverId);
    try {
      const label = query.appType
        ? APP_TYPE_LABEL[query.appType]
        : SWARM_SERVICE_LABEL;
      const command = `docker ps -a --filter='label=${label}=${query.appName}' --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | State: {{.State}} | Status: {{.Status}}'`;

      const { stdout, stderr } = await this.exec(serverId, command);
      if (stderr || !stdout) return [];

      // Blank lines dropped rather than `stdout.trim()`, as in `getContainers`
      // and `getTaskList` (H-80). This format's final field is one docker never
      // renders empty, so the trailing-space half of that bug is unreachable
      // here — but `!stdout` does not catch a blank-but-not-empty listing, which
      // parsed as one invented container.
      return stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const parts = line.split(' | ');
          return {
            containerId: parts[0]
              ? parts[0].replace('CONTAINER ID : ', '').trim()
              : 'No container id',
            name: parts[1]
              ? parts[1].replace('Name: ', '').trim()
              : 'No container name',
            state: parts[2]
              ? parts[2].replace('State: ', '').trim()
              : 'No state',
            status: parts[3] ? parts[3].replace('Status: ', '').trim() : '',
          };
        });
    } catch (error) {
      // A docker that ran and failed answers `[]`; a label filter matching
      // nothing exits 0 and never lands here. What is taken out of the catch is
      // the transport failure, which is not an empty listing (X11-4).
      rethrowIfHostUnreachable(this.logger, serverId, error);
    }

    return [];
  }

  /**
   * Running containers for one app, found by the swarm service label or
   * (standalone) the container's exact name — `name=^<appName>$`, anchored
   * because Docker's `name` filter is otherwise a substring match.
   * Gated on the Service the name resolves to first, like
   * {@link getContainersByOwnerLabel}.
   */
  async getContainersByAppLabel(
    ctx: PermissionCtx,
    query: {
      appName: string;
      type: 'standalone' | 'swarm';
      serverId?: string | null;
    },
  ): Promise<Array<Record<string, string>> | undefined> {
    await this.permissions.checkPermission(ctx, { docker: ['read'] });
    const serverId = await this.ownedServerId(ctx, query.serverId);
    await this.containerAccess.authorizeAppName(ctx, query.appName, serverId);
    try {
      const command =
        query.type === 'swarm'
          ? `docker ps --filter "label=com.docker.swarm.service.name=${query.appName}" --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | State: {{.State}}'`
          : `docker ps --filter "name=^${query.appName}$" --format 'CONTAINER ID : {{.ID}} | Name: {{.Names}} | State: {{.State}}'`;

      const { stdout, stderr } = await this.exec(serverId, command);
      if (stderr) {
        this.logger.error(`Error: ${stderr}`);
        return;
      }
      if (!stdout) return [];

      // Blank lines dropped rather than `stdout.trim()`, as in `getContainers`
      // and `getTaskList` (H-80). This format's final field is one docker never
      // renders empty, so the trailing-space half of that bug is unreachable
      // here — but `!stdout` does not catch a blank-but-not-empty listing, which
      // parsed as one invented container.
      return stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const parts = line.split(' | ');
          return {
            containerId: parts[0]
              ? parts[0].replace('CONTAINER ID : ', '').trim()
              : 'No container id',
            name: parts[1]
              ? parts[1].replace('Name: ', '').trim()
              : 'No container name',
            state: parts[2]
              ? parts[2].replace('State: ', '').trim()
              : 'No state',
          };
        });
    } catch (error) {
      // An empty catch, minus the transport failure (X11-4). Unlike its twin
      // above there is no nonzero-exit case this route depends on — the
      // `--filter` listings exit 0 with no rows — so the remaining `[]` is only
      // for a docker that ran and failed, which the `stderr` branch above
      // already answers `undefined` for. Left as it is rather than made
      // consistent in the same change: nothing in the console reads this route
      // (`lib/api/endpoints/docker.ts` declares no call for it), so there is no
      // screen to check the widening against.
      rethrowIfHostUnreachable(this.logger, serverId, error);
    }

    return [];
  }

  /**
   * `docker stack ps` tasks with the desired state lowercased.
   */
  getStackContainersByAppName(
    ctx: PermissionCtx,
    query: { appName: string; serverId?: string | null },
  ) {
    return this.getTaskList(ctx, query, ['docker', 'stack', 'ps']);
  }

  /** The `docker service ps` twin of the stack task listing. */
  getServiceContainersByAppName(
    ctx: PermissionCtx,
    query: { appName: string; serverId?: string | null },
  ) {
    return this.getTaskList(ctx, query, ['docker', 'service', 'ps']);
  }

  /**
   * **A Service's running containers, found by the Service rather than by the
   * machine**: what the Shell tab offers to open a shell in.
   *
   * Addressed by the Service's own id and gated on entitlement to it — on
   * `service:update`, the action `/docker-container-terminal` asks for, so
   * whatever this lists the socket accepts — and **not** on any `docker`
   * statement: the built-in member holds `docker: []`, and every other route
   * that would find a container id (`containers/service`, `/by-label`,
   * `/stack`, `/search`) is a machine-level read or takes a name. Every refusal
   * is `CONTAINER_DENIAL_MESSAGE` (`ContainerAccessService.authorizeService`).
   *
   * The machine is the Service's own: its Server, or the platform host when
   * `serverId` is null. A Service in a Cloud account has no container to list
   * and answers `[]` without asking any machine.
   *
   * `docker ps`, so only the containers **this daemon runs** — a replica
   * scheduled on another Swarm node is not listed, because `docker exec` on
   * this machine could not reach it ("never offer it and then
   * fail"). Running only, and filtered by the owner label the container gate
   * resolves the Service by, so a listed id is one the gate maps back to this
   * Service. A Compose stack's rows name their compose service: the
   * `com.docker.compose.service` label for `docker-compose`, the swarm service
   * name less its `${appName}_` prefix for a `stack`.
   *
   * A host that was not reached is a 503 (`host-reachability.ts`, X11-4),
   * which the tab words as the unreachable Server; a docker that ran and
   * failed answers `[]`.
   */
  async getServiceRunningContainers(
    ctx: PermissionCtx,
    target: ServiceAddress,
  ): Promise<ServiceContainer[]> {
    const service = await this.containerAccess.authorizeService(
      ctx,
      target,
      'update',
    );
    if (service.inCloud) return [];

    const label = service.composeType
      ? APP_TYPE_LABEL[service.composeType]
      : SWARM_SERVICE_LABEL;
    const serverId = service.serverId;
    try {
      // Argv, as `getTaskList`: the template is one word to `docker`, and the
      // label filter carries an `appName` that needs no quoting of its own.
      const { stdout, stderr } = await this.exec(serverId, [
        'docker',
        'ps',
        '--filter',
        'status=running',
        '--filter',
        `label=${label}=${service.appName}`,
        '--format',
        SERVICE_CONTAINER_FORMAT,
      ]);
      if (stderr || !stdout) return [];

      return stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const [containerId, name, state, composeLabel, swarmName] =
            line.split('|');
          const composeService =
            service.composeType === 'docker-compose'
              ? composeLabel
              : service.composeType === 'stack'
                ? swarmName?.replace(`${service.appName}_`, '')
                : undefined;
          return {
            containerId,
            name,
            state,
            ...(composeService ? { composeService } : {}),
          };
        });
    } catch (error) {
      rethrowIfHostUnreachable(this.logger, serverId, error);
    }
    return [];
  }

  /**
   * The shared body of the two task listings. Gated on the Service the name
   * resolves to: `docker: ['read']` is held by an owner or admin of
   * every organization, and on the platform host that read another
   * organization's Swarm tasks by name.
   */
  private async getTaskList(
    ctx: PermissionCtx,
    query: { appName: string; serverId?: string | null },
    commandPrefix: string[],
  ): Promise<Array<Record<string, string>>> {
    await this.permissions.checkPermission(ctx, { docker: ['read'] });
    const serverId = await this.ownedServerId(ctx, query.serverId);
    await this.containerAccess.authorizeAppName(ctx, query.appName, serverId);
    try {
      // Argv, so the Go template — which is full of spaces and pipes — is one
      // word to `docker` rather than a shell-quoted fragment, and `appName`
      // needs no quoting of its own.
      const { stdout, stderr } = await this.exec(serverId, [
        ...commandPrefix,
        query.appName,
        '--no-trunc',
        '--format',
        'CONTAINER ID : {{.ID}} | Name: {{.Name}} | State: {{.DesiredState}} | Node: {{.Node}} | CurrentState: {{.CurrentState}} | Error: {{.Error}}',
      ]);
      if (stderr || !stdout) return [];

      // Blank lines dropped rather than `stdout.trim()` (H-80, the same bug
      // one method over). This format's final field is
      // `Error: {{.Error}}`, which renders as `"Error: "` — trailing space, no
      // value — for a task that has not failed, and `trim()` strips that space
      // off the **final line only**. So the last task's error field read
      // `"Error:"` instead of empty, and a single-replica service has exactly
      // one task which is always last: every healthy one reported an error.
      // The `!stdout` guard above is also one whitespace character short of
      // catching a blank listing, which parsed as one invented task.
      return stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          const parts = line.split(' | ');
          return {
            containerId: parts[0]
              ? parts[0].replace('CONTAINER ID : ', '').trim()
              : 'No container id',
            name: parts[1]
              ? parts[1].replace('Name: ', '').trim()
              : 'No container name',
            state: parts[2]
              ? parts[2].replace('State: ', '').trim().toLowerCase()
              : 'No state',
            node: parts[3]
              ? parts[3].replace('Node: ', '').trim()
              : 'No specific node',
            currentState: parts[4]
              ? parts[4].replace('CurrentState: ', '').trim()
              : '',
            // `slice(5).join(' | ')` rather than `parts[5]` (H-81). `.Error` is
            // `task.Status.Err` — free text from the container runtime, and the
            // **one** field in any of this module's four listings whose value is
            // not a docker object name or a value docker composes from a fixed
            // template. So it is the one field that can contain the ` | ` the
            // row is split on, and `parts[5]` truncated the message there,
            // silently discarding the rest of exactly the string an operator is
            // reading a failed task to see.
            //
            // Rejoining is a complete fix **because `Error` is the last field**:
            // every part after index 5 belongs to it by construction, so the
            // value is reassembled rather than guessed at. That is also why this
            // needs no `--format` separator change — the expensive version of
            // this fix, and the next reader's first instinct. The two fields
            // before it are safe for the reason the delimiter was chosen:
            // `{{.Node}}` is a hostname, and `{{.CurrentState}}` is composed by
            // the docker CLI as `<TaskState enum> <humanized duration> ago`,
            // neither of which can contain a pipe.
            error: parts.slice(5).join(' | ').replace('Error: ', '').trim(),
          };
        });
    } catch (error) {
      // An empty catch, minus the transport failure (X11-4). The `[]` that
      // remains covers `docker stack ps` on a name that has no service, which
      // exits nonzero and is a genuine "no tasks"; both callers type this route
      // non-nullable, so it has no *would not say* state to widen into.
      rethrowIfHostUnreachable(this.logger, serverId, error);
    }

    return [];
  }

  /**
   * Stages the file base64-decoded under /tmp, `docker cp`s it to the
   * (slash-normalized) destination, and removes the staging file. Container id
   * and path are allowlist-validated because they are interpolated into a
   * shell command.
   *
   * **The statement is `docker: ['write']`, and that is a breaking
   * change for operators.** This line read `['read']`, which the lifecycle fix left behind
   * when it moved `containerOp`'s five verbs — so a *read* statement authorized
   * `docker cp` into any managed container the caller could address: overwrite
   * an application's config, drop a file where the app will execute it, replace
   * a binary on a writable layer. Same shape as the lifecycle defect, one route over,
   * and the write path was again more permissive than the benign
   * `POST /settings/traefik/reload`, which is `requireOwnerOrAdmin`.
   * **Any custom role that relies on `docker: ['read']` to upload into a
   * container must be re-granted `docker: ['read', 'write']`; nothing migrates
   * it.** Owner and admin hold the action outright and the base member holds no
   * `docker` action at all, so neither is affected. **A custom role
   * loses `docker cp` into an unmanaged container on the *platform host*
   * whatever it is granted** — that target takes instance authority, which is a
   * static role rather than a statement; see `containerOp`'s note.
   *
   * **`write` rather than a third action, deliberately.** It widens what `write`
   * means from "change this container's lifecycle" to also "put a file inside
   * it". That widening was a decision taken in triage rather than a
   * side effect of reusing the nearest word: a separate `upload`/`copy` action
   * would be a third `docker` statement whose only holder is one route, and
   * keeping the statement table small won. Nothing new was needed in
   * `access-control.ts` for it.
   *
   * **Done now rather than batched** with any further `docker` narrowing, which
   * asks operators to re-grant a second time so soon after the lifecycle fix. The hole is
   * the same class that fix closed, and leaving it standing to save one re-grant is
   * the trade it already refused.
   *
   * `['write']` alone rather than `['read', 'write']`, on `containerOp`'s and
   * `traefikFiles`' precedent: each route asks for the one action it needs. The
   * read is not lost — an *unmanaged* container still reaches
   * `authorizeAppNames`' machine branch, which asks for `docker:read` in its own
   * right.
   *
   * `getConfig` stays on `docker: ['read']`. It shares no gate with this method
   * any more, and it is a genuine read.
   */
  async uploadFileToContainer(
    ctx: PermissionCtx,
    input: {
      containerId: string;
      destinationPath: string;
      serverId?: string | null;
    },
    fileBuffer: Buffer,
    fileName: string,
  ): Promise<void> {
    await this.permissions.checkPermission(ctx, { docker: ['write'] });
    const serverId = await this.ownedServerId(ctx, input.serverId);

    const containerIdRegex = /^[a-zA-Z0-9.\-_]+$/;
    if (!containerIdRegex.test(input.containerId)) {
      throw new Error('Invalid container ID');
    }

    const destinationPathRegex = /^[a-zA-Z0-9.\-_/]+$/;
    if (!destinationPathRegex.test(input.destinationPath)) {
      throw new Error(
        'Invalid destination path: shell metacharacters are not allowed',
      );
    }

    // Deliberately *after* the two regexes and not before them: the gate
    // interpolates the container id into a `docker inspect` of its own, so
    // authorizing first would hand an unvalidated id to a shell one command
    // earlier than the one this method was careful about.
    await this.authorizeManagedContainer(ctx, input.containerId, serverId);

    const normalizedPath = input.destinationPath.startsWith('/')
      ? input.destinationPath
      : `/${input.destinationPath}`;

    const base64Content = fileBuffer.toString('base64');
    const tempFileName = `cloudgate-upload-${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const tempPath = `/tmp/${tempFileName}`;

    // `rc=$?` between the copy and the cleanup, and `exit $rc` after it, so the
    // command exits with **`docker cp`'s** status. It used to end
    // `… ; rm -f "$tmp"`, which makes the compound command's status `rm`'s —
    // effectively always 0 — so a failed copy was discarded, the catch below
    // never fired, and the route answered `{"success":true}` for an upload that
    // wrote nothing (a destination whose parent directory does not exist is the
    // easy case). The cleanup stays unconditional: it runs on the failure path
    // too, or every failed upload leaves its payload in `/tmp`.
    //
    // Nothing new is interpolated. The four values and their quoting are
    // unchanged: `base64Content` is base64's own alphabet inside single quotes,
    // `tempPath` is `/tmp/` plus a timestamp and a filename already reduced to
    // `[a-zA-Z0-9.-_]`, and `containerId` and `normalizedPath` are the two
    // regexes above — all three double-quoted. `rc=$?`, `exit $rc` and the two
    // `;` are literal.
    const command = `echo '${base64Content}' | base64 -d > "${tempPath}" && docker cp "${tempPath}" "${input.containerId}:${normalizedPath}" ; rc=$?; rm -f "${tempPath}"; exit $rc`;

    try {
      await this.exec(serverId, command);
    } catch (error) {
      throw new Error(
        `Failed to upload file to container: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** `docker container restart`; refused on a Server in maintenance. */
  restartContainer(ctx: PermissionCtx, input: ContainerOpInput) {
    return this.containerOp(ctx, input, ['docker', 'container', 'restart'], {
      startsContainer: true,
    });
  }

  /** `docker container start`; refused on a Server in maintenance. */
  startContainer(ctx: PermissionCtx, input: ContainerOpInput) {
    return this.containerOp(ctx, input, ['docker', 'container', 'start'], {
      startsContainer: true,
    });
  }

  /** `docker container stop`. */
  stopContainer(ctx: PermissionCtx, input: ContainerOpInput) {
    return this.containerOp(ctx, input, ['docker', 'container', 'stop']);
  }

  /** `docker container kill`. */
  killContainer(ctx: PermissionCtx, input: ContainerOpInput) {
    return this.containerOp(ctx, input, ['docker', 'container', 'kill']);
  }

  /** `docker rm -f`. */
  removeContainer(ctx: PermissionCtx, input: ContainerOpInput) {
    return this.containerOp(ctx, input, ['docker', 'rm', '-f']);
  }

  /**
   * The shared shape of the five container mutations: run the verb, throw the
   * stderr text when the daemon reports an error.
   *
   * All five are authorized here rather than in the five one-line wrappers
   * `docker rm -f`, `stop`, `kill`, `start` and `restart` differ only in
   * the verb, so a gate per wrapper is five places for the sixth verb to forget
   * it.
   *
   * **The statement is `docker: ['write']`, and that is a breaking
   * change for operators.** `docker` had exactly one action, so this line used
   * to read `['read']` and a *read* statement authorized all five: a licensed
   * custom role granted `docker: ['read']` could `docker rm -f` a managed
   * container while being refused `POST /settings/traefik/reload`, which is
   * `requireOwnerOrAdmin`. The destructive path was the more permissive of the
   * two. **Any custom role that relies on `docker: ['read']` to stop, kill,
   * start, restart or remove a container must be re-granted
   * `docker: ['read', 'write']`; nothing migrates it.** Owner, admin and the
   * base member are unaffected — the first two hold the new action outright and
   * the third held none to begin with.
   *
   * **And a second operator-facing note, which is not a re-grant.**
   * An **unmanaged** container on the **platform host** additionally takes
   * instance authority now, and `checkInstanceAuthority` reads the static role
   * and nothing else — so no `docker` grant restores it to a custom role. A
   * role that stops, kills, restarts or removes an operator's own sidecar on
   * the shared machine has to be held by an owner or admin of the instance
   * organization instead; on a named Server nothing changed. ADR-0013's third
   * consequence is why the boundary is not a statement: a grantable one would
   * let "Deploy engineer" quietly carry the platform host.
   *
   * `['write']` alone rather than `['read', 'write']`, on `traefikFiles`'
   * precedent (`settings.controller.ts` asks each route for the one action it
   * needs). The read is not lost: an *unmanaged* container still reaches
   * `authorizeAppNames`' machine branch below, which asks for `docker:read` in
   * its own right, so both are required for exactly the containers no Service
   * owns.
   *
   * The lifecycle fix moved only these five and scoped `uploadFileToContainer` out by name,
   * on the reasoning that `docker cp` into a container was the same shape one
   * route over and wanted its own fix. It got one: **the upload moved to
   * `docker: ['write']` too**, so the note that used to stand here — that the
   * upload was considered and left on `read` — is no longer true of the code.
   * Of the three routes that shared the old gate, `getConfig` is the one left
   * asking for `docker: ['read']`, and it is a genuine read. See `uploadFileToContainer`
   * for its own operator-facing note, including what taking `docker cp` under this word
   * widens `write` to mean.
   *
   * **`startsContainer`: start and restart are refused on a Server in
   * maintenance** (spec #1420), as a Service's Start is, once the Server is
   * known to be the caller's and before the container is looked up over SSH.
   * Stop, kill and remove are not: they start nothing.
   */
  private async containerOp(
    ctx: PermissionCtx,
    input: ContainerOpInput,
    commandPrefix: string[],
    { startsContainer = false }: { startsContainer?: boolean } = {},
  ): Promise<void> {
    await this.permissions.checkPermission(ctx, { docker: ['write'] });
    const serverId = await this.ownedServerId(ctx, input.serverId);
    if (startsContainer) await refuseWhileInMaintenance(this.db, [serverId]);
    await this.authorizeManagedContainer(ctx, input.containerId, serverId);
    const { stderr } = await this.exec(serverId, [
      ...commandPrefix,
      input.containerId,
    ]);

    if (stderr) {
      this.logger.error(`Error: ${stderr}`);
      throw new Error(stderr);
    }
  }

  /**
   * Local or remote dispatch by serverId — `remote/exec-dispatch.ts`'s, so a
   * `string[]` is one program and its arguments (nothing here
   * quotes) and a `string` is a shell program whose interpolations are the
   * caller's to `quote()`.
   */
  private exec(
    serverId: string | null | undefined,
    command: string | string[],
  ): Promise<ExecResult> {
    return execOnServer(this.remoteExec, serverId, command);
  }

  /**
   * The shared org-scope guard, projected to the id — every caller here wants
   * only that. Deliberately *not* named `checkServerAccess`: it used to be, and
   * that shadowed the imported function of the same name, so a reader of this
   * file met one identifier meaning two things.
   */
  private async ownedServerId(
    ctx: PermissionCtx,
    serverId?: string | null,
  ): Promise<string | undefined> {
    const scoped = await checkServerAccess(this.db, ctx, serverId);
    return scoped?.serverId;
  }

  /**
   * The gate every container-addressed route runs before it touches the
   * container.
   *
   * Neither of the two checks in front of it is a claim about *this container*:
   * the `docker` statement each route asks for — `read`, or `write` for the five
   * destructive verbs — is an organization-level capability, and
   * {@link ownedServerId} resolves an absent `serverId` to `undefined` —
   * ADR-0008's documented contract for the platform host, which is the daemon
   * every organization's services share. So on the platform host a member of
   * one organization could `docker rm -f`,
   * stop, kill, restart, `inspect` or `docker cp` into another organization's
   * running Application by id.
   *
   * This is ADR-0008's own gate, the one the three sockets use, rather than a
   * second copy: a container is resolved to the Service that owns it and refused
   * when that Service is in another organization. A container resolving to no
   * Service is **unmanaged** — anything an operator started by hand — and stays
   * governed by machine-level Docker access on a **named Server**, so those
   * behave exactly as they did before.
   *
   * **On the platform host an unmanaged container additionally takes instance
   * authority**, which is what closes the second half of the
   * paragraph above rather than merely describing it: the `docker` statement is
   * an organization capability and `ownedServerId` answers `undefined` here by
   * design, so the two checks in front of this one never asked whether the
   * caller administers the machine every organization's services share. The
   * decision, the rejected alternative and the cost are in ADR-0013 beside
   * its two other surfaces, and the check itself is in
   * `ContainerAccessService.authorizeAppNames` rather than here — three routes
   * on this class and three sockets share it, and a socket's lease has to be
   * able to re-run it.
   *
   * **With one exception: a container this instance runs for itself.**
   * `cloudgate-traefik`, `cloudgate-backend` and `cloudgate-console` are
   * unmanaged in the label sense — the installer starts them with no labels at
   * all — so the sentence above used to hand all seven routes an object that the
   * listing hid from every organization, including the instance owner's. They
   * are now refused here like a foreign container, and with the same message.
   * Nothing an operator legitimately does to them goes through this table:
   * `POST /settings/traefik/{reload,restart,…}` is the surface, and it is
   * gated on `requireOwnerOrAdmin` rather than on `docker:read`. Do not
   * "restore" the old behaviour — see {@link isPlatformContainerName}.
   *
   * `runType` is `standalone` and never `swarm`: these routes are reached from
   * the console's container table, whose ids come out of `docker ps`, so the
   * parameter is always a container and never a swarm service name.
   */
  private async authorizeManagedContainer(
    ctx: PermissionCtx,
    containerId: string,
    serverId: string | undefined,
  ): Promise<void> {
    await this.containerAccess.authorizeContainer(
      ctx,
      {
        containerId,
        serverId,
        runType: 'standalone',
      },
      'read',
    );
  }
}
