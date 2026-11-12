import { api } from "../client";

/**
 * `docker-ops.controller.ts` — the containers on a host, and the four verbs you
 * can aim at one.
 *
 * **Every route here shells out to the docker CLI and parses `--format` output**
 * (locally, or over SSH when `serverId` is set). That shape decides three things
 * a screen has to live with:
 *
 * 1. **A failure is often an empty array.** `getContainersByOwnerLabel`
 *    answers `[]` when docker ran and failed, and
 *    `getContainers` answers an empty body when docker wrote to stderr
 *    (`dockerApi.containers` resolves that as `null`). So "nothing
 *    came back" is not "nothing is running" — a caller that renders zero rows as
 *    an empty state is making a claim the endpoint cannot support.
 *
 *    **Except for the one failure that used to be the worst of them** (X11-4).
 *    A Server that could not be reached at all was in that same empty array:
 *    `GET /docker/containers?serverId=…` answered `200 []` in 28 ms for a host
 *    at `127.0.0.1:1`, `/swarm/apps` and `/swarm/nodes` did the same, and the
 *    Docker & Swarm tab told an operator mid-incident that Docker had answered
 *    and their containers were gone. It is now a **503 carrying
 *    `code: "HOST_UNREACHABLE"`** — or `"PLATFORM_HOST_UNREACHABLE"` when the
 *    read carried no `serverId` and so addressed the machine Cloudgate runs on.
 *    `isUnreachableHost(error)` in `lib/api/api-error.ts` covers either and is
 *    the test a card that only ever reads one machine should use; `errorMessage()`
 *    branches on the two so a reader that does not branch still says the right
 *    thing about the right machine, which for a whole release it did not. What is
 *    left in the empty array is a command that *ran*: a docker that failed, a
 *    `docker stack ps` on a name with no service. The reason the connection
 *    failed stays in the backend journal, the way `runtime-info`'s `reason`
 *    stays off the Ingress row.
 *
 *    Three of the routes below therefore have **three** answers rather than two
 *    — rows, `undefined`/`null` for *docker would not say*, and a 503 for *the
 *    machine was never reached* — and the three cards on a Server's Docker tab
 *    render all three separately. **No query here needs a `retry` override for
 *    it**:
 *    `retryUnlessTheAnswerWillNotChange` in `lib/api/query-client.ts` stops on
 *    that code, so an unreachable Server costs one SSH attempt rather than the
 *    three a 5xx is otherwise retried for. This paragraph used to say the
 *    opposite and point at the three cards' hand-written `retry: false`, which
 *    is what the next three queries — `useStackContainers`'s — inherited the
 *    retries by not knowing about.
 *
 * 2. **The fields differ per route** because the `--format` strings differ, and
 *    only the full listing carries an image or a port map. There is no route that
 *    is both narrowed to one app *and* carries the image, which is why the
 *    Containers tab joins two.
 * 3. **`containers/stack` and `containers/service` return Swarm *tasks*, not
 *    containers.** `{{.ID}}` from `docker stack ps` is a task id, so it is not
 *    something the four lifecycle routes or the container-logs gateway accept —
 *    those want the container id that `containers` and `containers/search`
 *    return. A task carries what no container does: which node it landed on, and
 *    why it did not start.
 *
 * **F12 declared only what a Compose stack's screens read. F13 finishes it**, and
 * widens it to the whole `docker-ops` backend module: the containers controller,
 * `swarm.controller.ts` and `cluster.controller.ts` are three controllers over
 * one module and one host, so they are one module here. The only route still
 * absent is `POST /containers/:id/upload`, which needs a multipart body no screen
 * in the console asks for.
 *
 * Two things to know before reading the Server scope's Docker tab:
 *
 * 4. **Every read here is scoped by `?serverId=`, and omitting it means the
 *    platform's own host** — `checkServerAccess` resolves the row inside the
 *    caller's Organization and `exec` forks between `execAsyncRemote` and a local
 *    `execAsync`. So `null` is a real target, not a missing parameter, which is
 *    why `keys.docker` puts `serverId` first.
 * 5. **The join commands are `GET` routes that mint a secret.** `add-worker` and
 *    `add-manager` return `docker swarm join --token …`; the token is the whole
 *    credential for joining a cluster. They are queries by HTTP method and
 *    credentials by content, so nothing fetches them until someone asks.
 */

/** One row of `docker ps -a`, from `GET /docker/containers`. */
export interface ContainerListItem {
  containerId: string;
  name: string;
  image: string;
  /** As docker prints it: `0.0.0.0:8080->80/tcp`, or empty. */
  ports: string;
  /** `docker ps {{.State}}` — running, exited, created, paused, dead, … */
  state: string;
  /** The human phrasing beside it: `Up 4 minutes`, `Exited (0) 1 hour ago`. */
  status: string;
  serverId: string | null | undefined;
}

/** `GET /docker/containers/search` — narrowed to one app, and no image. */
export interface ContainerMatch {
  containerId: string;
  name: string;
  state: string;
  status: string;
}

/**
 * The kinds of Service whose running containers can be listed by the Service
 * every kind with a workload of its own — a bucket has none. The
 * backend's `WorkloadServiceType` (`WORKLOAD_SERVICE_TYPES`), by the same name.
 */
export type WorkloadServiceType =
  | "application"
  | "compose"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongo"
  | "redis"
  | "libsql";

/**
 * One running container of a Service, from
 * `GET /docker/services/:serviceType/:serviceId/containers`.
 */
export interface ServiceContainer {
  containerId: string;
  /** Docker's generated name, `app-9uiusu.1.…` — what the picker shows. */
  name: string;
  state: string;
  /** A Compose stack's service this container runs; absent for any other kind. */
  composeService?: string;
}

/**
 * One Swarm task, from `GET /docker/containers/stack`.
 *
 * `containerId` is the **task** id (see the note above). `state` is the desired
 * state lowercased — which is what `TASK_STATE` in `lib/design/status.ts` is
 * keyed on — and `currentState` is docker's own sentence about where it got to.
 */
export interface SwarmTask {
  containerId: string;
  name: string;
  state: string;
  node: string;
  currentState: string;
  /** Why the task did not run. Empty when there is nothing wrong. */
  error: string;
}

/** How a stack's containers are found: by compose project label, or by name. */
export type ContainerAppType = "stack" | "docker-compose";

/**
 * One row of `docker node ls --format '{{json .}}'`, from `GET /swarm/nodes`.
 *
 * **These are Docker's own field names and they keep them** — the vocabulary rule
 * covers our nouns, not a third party's output. The service answers `unknown[]`
 * (it `JSON.parse`s each line and hands it straight on), so this type is a
 * statement about a `--format` string in `swarm.service.ts` rather than something
 * the backend enforces; every field is therefore optional in spirit and the
 * screen renders a `Dash` for anything missing.
 *
 * `ManagerStatus` is `""` for a worker, and `Leader` / `Reachable` /
 * `Unavailable` for a manager.
 */
export interface SwarmNode {
  ID: string;
  Hostname: string;
  /** `Ready` · `Down` · `Unknown` — the node's connection to the cluster. */
  Status: string;
  /** `Active` · `Pause` · `Drain` — whether it may be given work. */
  Availability: string;
  ManagerStatus: string;
  EngineVersion: string;
  TLSStatus?: string;
  /** True for the node the command ran on. */
  Self?: boolean;
}

/** One row of `docker service ls --format '{{json .}}'`, from `GET /swarm/apps`. */
export interface SwarmService {
  ID: string;
  Name: string;
  Mode: string;
  /** As docker prints it: `1/1`, `0/3`, `2/2 (max 1 per node)`. */
  Replicas: string;
  Image: string;
  /** `*:8080->80/tcp`, or empty. */
  Ports: string;
}

/** What `add-worker` / `add-manager` answer with. A command, not a join. */
export interface JoinCommand {
  /** `docker swarm join --token <token> <addr>:2377`. Contains a live secret. */
  command: string;
  /** The Docker version of the cluster being joined, for a version check. */
  version: string;
}

export const dockerApi = {
  /**
   * Every container on the host, with its image and ports.
   *
   * **Resolves `null`, not `[]`, when docker would not say** — the route
   * returns nothing at all when the docker command writes to stderr, and since
   * X11-4 when it exits nonzero too (a daemon that is not running). The body is
   * empty, which `api.get` reads as `undefined`. Worth keeping apart from an
   * empty array, which means docker answered and there are none.
   *
   * **The `?? null` lives here, not in the callers**. TanStack Query
   * refuses `undefined` as query data, and three queries share this one cache
   * key: two callers mapped it and `LiveCard` did not, so whichever filled the
   * cache first decided whether `/monitoring` said "an error it does not
   * recognise". Mapping it once means no caller can forget.
   *
   * **And a 503 `HOST_UNREACHABLE` when the Server was never reached**, which is
   * the answer this used to give `[]` for — `PLATFORM_HOST_UNREACHABLE` when
   * `serverId` is absent, which is this route's default and is the arm `LiveCard`
   * takes.
   *
   * Containers whose name contains `cloudgate` are filtered out by the backend
   * (except the monitoring one), so the platform's own containers never appear.
   */
  containers: (serverId?: string | null): Promise<ContainerListItem[] | null> =>
    api
      .get<ContainerListItem[] | undefined>("/docker/containers", {
        query: { serverId: serverId ?? undefined },
      })
      .then((rows) => rows ?? null),

  /**
   * The containers of one app, by an exact owner label: for `docker-compose`
   * `com.docker.compose.project`, for `stack` `com.docker.stack.namespace`,
   * which every one of a Swarm stack's `<appName>_<service>.N.<task>`
   * containers carries. The backend refuses a name the caller is not entitled
   * to with a 403 before anything runs.
   */
  containersByApp: (params: {
    appName: string;
    appType: ContainerAppType;
    serverId?: string | null;
  }) =>
    api.get<ContainerMatch[]>("/docker/containers/search", {
      query: {
        appName: params.appName,
        appType: params.appType,
        serverId: params.serverId ?? undefined,
      },
    }),

  /** `docker stack ps <appName>` — the tasks, with their node and their error. */
  stackTasks: (params: { appName: string; serverId?: string | null }) =>
    api.get<SwarmTask[]>("/docker/containers/stack", {
      query: {
        appName: params.appName,
        serverId: params.serverId ?? undefined,
      },
    }),

  /**
   * `docker service ps <appName>` — an **Application's** tasks, across every
   * node of its Swarm. An Application is a service, not a stack, so
   * `stackTasks` finds nothing for one. The Overview reads it to tell "the
   * previous Deployment is still serving" from "nothing is".
   *
   * `docker: ['read']`, which a base member does not hold, and a service that
   * does not exist answers `[]` (docker writes to stderr). So a caller reads a
   * refusal as "cannot say" and `[]` as "nothing running", never the reverse.
   */
  serviceTasks: (params: { appName: string; serverId?: string | null }) =>
    api.get<SwarmTask[]>("/docker/containers/service", {
      query: {
        appName: params.appName,
        serverId: params.serverId ?? undefined,
      },
    }),

  /**
   * **A Service's running containers, found by the Service**: the
   * Shell tab's picker, and anything else that needs a Service's container id
   * without a `docker` statement. Gated on `service:update` on the Service —
   * the action the terminal socket asks for, so every id it answers is one the
   * socket accepts — and listed on the Service's own machine only, so a
   * replica on another Swarm node is never offered. Every refusal is a 403
   * saying "Container not found or not permitted"; a Server that was not
   * reached is a 503 `HOST_UNREACHABLE` (`PLATFORM_HOST_UNREACHABLE` on the
   * platform host); a Service in a Cloud account answers `[]`.
   */
  serviceContainers: (serviceType: WorkloadServiceType, serviceId: string) =>
    api.get<ServiceContainer[]>(
      `/docker/services/${serviceType}/${encodeURIComponent(serviceId)}/containers`,
    ),

  /**
   * The four verbs. Each is `docker container <verb> <id>` and answers 200 with
   * an empty body, or **500 carrying docker's own stderr** — the service throws a
   * bare `Error(stderr)`, so "No such container" arrives as a server error.
   *
   * `serverId` travels in the **body** here and in the query string on the reads,
   * which is the controller's shape, not a choice.
   */
  start: (containerId: string, serverId?: string | null) =>
    api.post<void>(`/docker/containers/${containerId}/start`, {
      serverId: serverId ?? undefined,
    }),

  stop: (containerId: string, serverId?: string | null) =>
    api.post<void>(`/docker/containers/${containerId}/stop`, {
      serverId: serverId ?? undefined,
    }),

  restart: (containerId: string, serverId?: string | null) =>
    api.post<void>(`/docker/containers/${containerId}/restart`, {
      serverId: serverId ?? undefined,
    }),

  /** `SIGKILL`, not a graceful stop. The menu says which is which. */
  kill: (containerId: string, serverId?: string | null) =>
    api.post<void>(`/docker/containers/${containerId}/kill`, {
      serverId: serverId ?? undefined,
    }),

  /**
   * `docker rm -f` — a **fifth** verb, and the one that is not a lifecycle
   * change. It destroys the container, so a Swarm-managed one comes straight
   * back and a hand-run one does not. The dialog says which.
   *
   * `serverId` travels in the **query string** here, unlike the four POSTs above,
   * because this is a `DELETE`. The controller's shape, not a choice.
   */
  remove: (containerId: string, serverId?: string | null) =>
    api.delete<void>(`/docker/containers/${containerId}`, {
      query: { serverId: serverId ?? undefined },
    }),

  /**
   * `docker inspect <id>`, whole.
   *
   * **Answers `undefined` for every kind of failure** — an unknown container, a
   * docker that wrote to stderr, output that would not parse — because
   * `getConfig` catches everything into an empty block. So there is no way to
   * tell "no such container" from "docker is unhappy", and the viewer says only
   * that the inspection came back empty.
   *
   * Typed `unknown`: it is the Engine API's container document, forty keys deep
   * and versioned by Docker rather than by us. Declaring a shape for it would be
   * a promise this codebase cannot keep, so it is rendered as the JSON it is.
   */
  config: (containerId: string, serverId?: string | null) =>
    api.get<unknown>(`/docker/containers/${containerId}/config`, {
      query: { serverId: serverId ?? undefined },
    }),

  // ------------------------------------------------------------------- swarm

  /**
   * `docker node ls` — every node in the Swarm this host belongs to.
   *
   * **Answers `undefined` when docker wrote to stderr**, which is the normal
   * reply from a *worker*: `docker node ls` is a manager-only command. Keeping
   * that apart from `[]` is what stops the screen saying "this Swarm has no
   * nodes" about a Swarm it is simply not allowed to enumerate.
   *
   * A Server that was not reached is neither, and answers 503
   * `HOST_UNREACHABLE` (X11-4) — until then it arrived here as the worker's
   * `undefined`, so the card said "this is the normal answer from a worker"
   * about a machine nothing had spoken to.
   */
  swarmNodes: (serverId?: string | null) =>
    api.get<SwarmNode[] | undefined>("/swarm/nodes", {
      query: { serverId: serverId ?? undefined },
    }),

  /**
   * `docker service ls` — the Swarm services running on this host, with the
   * platform's own `cloudgate-*` ones filtered out by the backend.
   *
   * **This is Docker's answer, not Cloudgate's.** Cloudgate's is
   * `GET /environments/:id`, which names the services in one Environment
   * this answers a
   * different question, about one host. It cannot say which Project or Environment
   * a service belongs to, and a service deployed as a plain container rather than a
   * Swarm service is not in it at all. What it *can* do is name what is running before a Server is
   * deleted, which is the one question that has to be answered honestly.
   *
   * Which is why X11-4 mattered most here: an unreachable Server answered
   * `200 []`, so the honest question got the reassuring answer. It is a 503
   * `HOST_UNREACHABLE` now, and `undefined` only for a docker that ran and
   * would not say.
   */
  swarmServices: (serverId?: string | null) =>
    api.get<SwarmService[] | undefined>("/swarm/apps", {
      query: { serverId: serverId ?? undefined },
    }),

  // ----------------------------------------------------------------- cluster

  /**
   * The command that would add a node to this Swarm. **It performs no join** —
   * the route reads the cluster's join token and formats a string; somebody has
   * to run it on the machine that is joining. The screen says so where the
   * command is, because "Add a worker" on a button that copies text is the kind
   * of label people press once and then wait for something to happen.
   */
  joinCommand: (role: "worker" | "manager", serverId?: string | null) =>
    api.get<JoinCommand>(`/cluster/add-${role}`, {
      query: { serverId: serverId ?? undefined },
    }),

  /**
   * Drain a node, then `docker node rm --force` it.
   *
   * Two commands, in that order, and the drain is the part worth saying out loud:
   * every task on the node is rescheduled elsewhere before it goes. Any failure
   * arrives as a 500 wrapping the exec error.
   */
  removeNode: (nodeId: string, serverId?: string | null) =>
    api.delete<boolean>(`/cluster/nodes/${nodeId}`, {
      query: { serverId: serverId ?? undefined },
    }),
};
