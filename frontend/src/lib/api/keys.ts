import type { WorkloadServiceType } from "./endpoints/docker";

/**
 * Every query key in the app, in one place.
 *
 * There are exactly two roots, and which one a key sits under is a statement
 * about whose data it is:
 *
 * - **`org(id)`** — tenant data. Projects, Environments, Applications,
 *   Deployments, Servers, members, invitations, teams. Switching the active
 *   Organization moves to a different subtree, so a cached list can never be
 *   handed to the wrong tenant. `useInvalidate().organizationChanged()` drops
 *   the old subtree outright.
 * - **`account`** — the signed-in person. Their profile, sessions, API keys, and
 *   the list of Organizations they belong to. None of it changes when they
 *   switch Organization, and scoping it per-organization would only refetch the
 *   same rows under a new key.
 *
 * `organizationId` is `null` while the session loads and when the caller has no
 * active Organization. A query keyed on `null` must not run — pass
 * `enabled: organizationId !== null`.
 *
 * F06 added a third root, and it is the exception that proves the rule:
 *
 * - **`instance`** — how *this deployment of Cloudgate* is configured, read
 *   before anyone is signed in. Whether the sign-in screen offers SSO at all is
 *   the example. It is neither tenant data nor the signed-in person's, because at
 *   the moment it is read there is no tenant and no person; filing it under
 *   `account` would put it in the subtree that `signOut` clears, on a screen
 *   reached by signing out.
 */

export type OrganizationScope = string | null;

const org = (organizationId: OrganizationScope) =>
  ["org", organizationId] as const;

const account = ["account"] as const;

const instance = ["instance"] as const;

export const keys = {
  /** The whole tenant subtree — the unit that gets dropped on a switch. */
  org,
  account,
  instance,

  /** What the door offers before anyone has opened it. */
  ssoSignIn: () => [...instance, "sso", "sign-in"] as const,

  /**
   * Whether SSO is the **only** way in (F18).
   *
   * Under `instance` beside its neighbour and not under `org`, because it is not
   * the Organization's: `enforceSso` reads a single `web_server_settings` row and
   * the route is `@Public()`. One switch, every tenant on this deployment.
   */
  ssoEnforce: () => [...instance, "sso", "enforce"] as const,

  /**
   * Whether this instance still has no owner — `GET /auth/sign-up-open`, the
   * third `@Public()` read of how this deployment is configured.
   *
   * **Two hooks share this key and must not be merged into one**
   * Sharing the
   * key is the point: the answer is one fact about the deployment, and the second
   * caller usually finds it in cache. Their *failure* semantics are opposites, on
   * purpose.
   *
   * - `app/(auth)/_components/use-sign-up-open.ts` **fails open** to the form. It
   *   is the screen that claims the instance, and treating an unreachable backend
   *   as "closed" would replace the only way to set the instance up with a dead
   *   end.
   * - `components/shell/dead-session-exit.tsx` **fails closed** to sign-in. It is
   *   deciding where to send someone whose session is gone, and reading a failed
   *   read as "nobody owns this" would announce an unclaimed instance to a
   *   visitor of one that has an owner.
   *
   * A future deduplication of the two hooks silently gives one of them the
   * other's answer to a dropped connection.
   */
  signUpOpen: () => [...instance, "sign-up-open"] as const,
  /** Whether password reset can send anything here. */
  passwordResetOpen: () => [...instance, "password-reset-open"] as const,
  /**
   * An invitation link as a signed-out visitor sees it: open, with its
   * Organization and address, or not. Instance-scoped like `signUpOpen` — there
   * is no account yet to scope it by.
   */
  invitationPreview: (invitationId: string) =>
    [...instance, "invitation-preview", invitationId] as const,

  /**
   * The instance's branding — `GET /settings/whitelabeling`, the fourth
   * `@Public()` read of how this deployment is configured. Under `instance`
   * with its neighbours: one `web_server_settings` row, whichever Organization
   * is looking, and the sign-in screen reads it before there is one.
   */
  branding: () => [...instance, "branding"] as const,

  me: () => [...account, "me"] as const,
  mySessions: () => [...account, "sessions"] as const,
  myApiKeys: () => [...account, "api-keys"] as const,
  /**
   * The Operator page (ADR-0050). Under `account`: being an Operator is the
   * person's standing in the Instance organization, whichever Organization is
   * active, and the list spans every Organization rather than one tenant.
   */
  operatorAccess: () => [...account, "operator", "access"] as const,
  operatorOrganizations: () =>
    [...account, "operator", "organizations"] as const,
  /** The Operator page's Bought Servers: the list, and the settings under it. */
  operatorBoughtServers: () =>
    [...account, "operator", "bought-servers"] as const,
  operatorBoughtServerSettings: () =>
    [...account, "operator", "bought-servers", "settings"] as const,
  /** Under the Bought Servers prefix, so its invalidation refreshes this too. */
  operatorOrphanMachines: () =>
    [...account, "operator", "bought-servers", "orphans"] as const,
  /** The Operator page's open abuse reports (#1401). */
  operatorAbuseReports: () =>
    [...account, "operator", "abuse-reports"] as const,
  /** A reprice preview of these Bought Servers, under the list's prefix (#1400). */
  operatorRepricePreview: (ids: readonly string[]) =>
    [...account, "operator", "bought-servers", "reprice", ...ids] as const,
  /** Which Organizations this person belongs to — theirs, not any one org's. */
  myOrganizations: () => [...account, "organizations"] as const,
  /**
   * Where this person goes next from Choose an Organization: under
   * `myOrganizations`, so invalidating their memberships re-decides it.
   */
  /**
   * Whether this person may make another Organization now. Under
   * `myOrganizations`, so a create or delete re-asks it; and under `account`,
   * so switching Organization (which changes their role) does too.
   */
  myOrganizationCreation: () =>
    [...account, "organizations", "creation"] as const,
  myOrganizationDestination: (next: string) =>
    [...account, "organizations", "destination", next] as const,
  /**
   * An invitation addressed to this person, read by its link. Theirs rather
   * than any Organization's: they are not a member of it yet.
   */
  myInvitation: (invitationId: string) =>
    [...account, "invitations", invitationId] as const,
  /** What became of that invitation, from Cloudgate's state route. */
  myInvitationState: (invitationId: string) =>
    [...account, "invitations", invitationId, "state"] as const,

  organization: {
    detail: (organizationId: OrganizationScope) =>
      [...org(organizationId), "detail"] as const,
    members: (organizationId: OrganizationScope) =>
      [...org(organizationId), "members"] as const,
    invitations: (organizationId: OrganizationScope) =>
      [...org(organizationId), "invitations"] as const,
    teams: (organizationId: OrganizationScope) =>
      [...org(organizationId), "teams"] as const,
    teamMembers: (organizationId: OrganizationScope, teamId: string) =>
      [...org(organizationId), "teams", teamId, "members"] as const,
    /**
     * `GET /agents`. Beside `members` because an Agent is one: the
     * Members card's pointer line counts Agents off the member list, so every
     * Agent write calls `membership()`, which widens over both.
     */
    agents: (organizationId: OrganizationScope) =>
      [...org(organizationId), "agents"] as const,
  },

  projects: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "projects"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "projects", "list"] as const,
    detail: (organizationId: OrganizationScope, projectId: string) =>
      [...org(organizationId), "projects", projectId] as const,
    /** `GET /projects/:id/config`. */
    config: (organizationId: OrganizationScope, projectId: string) =>
      [...org(organizationId), "projects", projectId, "config"] as const,
    /** `GET /projects/:id/token-spend`: the last 30 days. */
    tokenSpend: (organizationId: OrganizationScope, projectId: string) =>
      [...org(organizationId), "projects", projectId, "token-spend"] as const,
  },

  /**
   * A Tag belongs to the Organization; its *assignment* belongs to a Project.
   * `byProject` therefore sits under `tags` and not under `projects`, so
   * attaching a Tag invalidates one subtree rather than every Project detail.
   */
  tags: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "tags"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "tags", "list"] as const,
    byProject: (organizationId: OrganizationScope, projectId: string) =>
      [...org(organizationId), "tags", "by-project", projectId] as const,
  },

  /**
   * The two feeds sit **under** `detail`, and that nesting is the statement:
   * `invalidate.environment({ environmentId })` invalidates by prefix, so
   * anything that changes what an Environment holds — an Application created, a
   * database deleted, a stack deployed — drops both feeds with the row they
   * belong to, with no second call to remember.
   */
  environments: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "environments"] as const,
    byProject: (organizationId: OrganizationScope, projectId: string) =>
      [
        ...org(organizationId),
        "environments",
        "by-project",
        projectId,
      ] as const,
    detail: (organizationId: OrganizationScope, environmentId: string) =>
      [...org(organizationId), "environments", environmentId] as const,
    /** `GET /environments/:id/deployments`. */
    deployments: (organizationId: OrganizationScope, environmentId: string) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "deployments",
      ] as const,
    /** `GET /environments/:id/domains`. */
    domains: (organizationId: OrganizationScope, environmentId: string) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "domains",
      ] as const,
    /** `GET /environments/:id/networks`. */
    networks: (organizationId: OrganizationScope, environmentId: string) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "networks",
      ] as const,
    /**
     * `GET /environments/:id/networks/:networkId/resources`, under
     * the networks, so whatever refreshes them refreshes it.
     */
    networkResources: (
      organizationId: OrganizationScope,
      environmentId: string,
      environmentNetworkId: string,
    ) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "networks",
        environmentNetworkId,
        "resources",
      ] as const,
    /**
     * `GET /environments/:id/plan`: the open plan, else the latest.
     * Under the Environment, so whatever invalidates it reaches its plan.
     */
    plan: (organizationId: OrganizationScope, environmentId: string) =>
      [...org(organizationId), "environments", environmentId, "plan"] as const,
    /**
     * `GET /environments/:id/pending-setups`: its Pending setups and the
     * 30-day sweep's notes. Under the Environment, like its plan.
     */
    pendingSetups: (organizationId: OrganizationScope, environmentId: string) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "pending-setups",
      ] as const,
    /**
     * `GET /environments/:id/config`: the Environment's copy of a
     * repository-kept config, read from its Config branch.
     */
    configCopy: (organizationId: OrganizationScope, environmentId: string) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "config-copy",
      ] as const,
    /**
     * `GET /:kind/existing/reach`: where an Environment's
     * Services reach an existing database from, under the Environment; for a bucket
     * (`GET /buckets/existing/reach`), the grant its lookup needs.
     */
    existingReach: (
      organizationId: OrganizationScope,
      environmentId: string,
      kind: "postgres" | "mysql" | "redis" | "bucket",
    ) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "existing-reach",
        kind,
      ] as const,
    /** `GET /environments/:id/token-spend`: the last 30 days. */
    tokenSpend: (organizationId: OrganizationScope, environmentId: string) =>
      [
        ...org(organizationId),
        "environments",
        environmentId,
        "token-spend",
      ] as const,
  },

  applications: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "applications"] as const,
    detail: (organizationId: OrganizationScope, applicationId: string) =>
      [...org(organizationId), "applications", applicationId] as const,
    /**
     * `GET /services/application/:id/links`, under the Application,
     * so what refreshes the Application refreshes its links.
     */
    links: (organizationId: OrganizationScope, applicationId: string) =>
      [...org(organizationId), "applications", applicationId, "links"] as const,
    /** `GET /applications/:id/gpu-wait`, under the Application. */
    gpuWait: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "applications",
        applicationId,
        "gpu-wait",
      ] as const,
    /** `GET /applications/:id/cloud-resources`, under the Application. */
    cloudResources: (
      organizationId: OrganizationScope,
      applicationId: string,
    ) =>
      [
        ...org(organizationId),
        "applications",
        applicationId,
        "cloud-resources",
      ] as const,
    /**
     * `GET /applications/:id/token-spend`, under the Application,
     * by the window asked for — `"all"` when the route picks it.
     */
    tokenSpend: (
      organizationId: OrganizationScope,
      applicationId: string,
      window: { from?: string; to?: string },
    ) =>
      [
        ...org(organizationId),
        "applications",
        applicationId,
        "token-spend",
        window.from ?? "all",
        window.to ?? "today",
      ] as const,
  },

  /**
   * A managed database is keyed by **engine and id**, because that pair is what
   * addresses it: `GET /:id` is only answerable per controller
   * (`endpoints/databases.ts`), so the engine is part of the request and
   * therefore part of the key.
   */
  /** `GET /buckets/:id`. Nothing lists buckets but their Environment. */
  buckets: {
    detail: (organizationId: OrganizationScope, bucketId: string) =>
      [...org(organizationId), "buckets", bucketId] as const,
  },

  databases: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "databases"] as const,
    detail: (
      organizationId: OrganizationScope,
      kind: string,
      databaseId: string,
    ) => [...org(organizationId), "databases", kind, databaseId] as const,
    /** `GET /services/:kind/:id/links`, under the database. */
    links: (
      organizationId: OrganizationScope,
      kind: string,
      databaseId: string,
    ) =>
      [...org(organizationId), "databases", kind, databaseId, "links"] as const,
    /** `GET /:kind/:id/cloud-backups`, under the database. */
    cloudBackups: (
      organizationId: OrganizationScope,
      kind: string,
      databaseId: string,
    ) =>
      [
        ...org(organizationId),
        "databases",
        kind,
        databaseId,
        "cloud-backups",
      ] as const,
    /**
     * `GET /:kind/:id/final-snapshot`, under the database:
     * the snapshot a Delete pressed now keeps, read while its dialog is open.
     */
    finalSnapshot: (
      organizationId: OrganizationScope,
      kind: string,
      databaseId: string,
    ) =>
      [
        ...org(organizationId),
        "databases",
        kind,
        databaseId,
        "final-snapshot",
      ] as const,
  },

  compose: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "compose"] as const,
    detail: (organizationId: OrganizationScope, composeId: string) =>
      [...org(organizationId), "compose", composeId] as const,
    /**
     * The service names the stack's **file** declares —
     * `GET /compose/:id/services`. F12's audit: it parses the compose file (the
     * stored one for a `raw` source, the clone on the build Server otherwise),
     * so it says nothing about what is running. Live state is `docker.*` below.
     */
    services: (organizationId: OrganizationScope, composeId: string) =>
      [...org(organizationId), "compose", composeId, "services"] as const,
    /**
     * `GET /compose/:id/stack-vm`: whether its Stack VM runs, read from the
     * cloud. Under the stack's detail, so Stop and Start re-read it.
     */
    stackVm: (organizationId: OrganizationScope, composeId: string) =>
      [...org(organizationId), "compose", composeId, "stack-vm"] as const,
  },

  /**
   * Containers on a host, keyed by **`serverId` first**, because that is what the
   * request is really about: every one of these routes shells out to the docker
   * CLI on one machine, and `null` — the platform's own host — is a real key
   * rather than a missing one (`keys.traefik` does the same for the same reason).
   *
   * F12 added the three a Compose stack's screens read. **F13 added the four
   * Server scope's Docker tab needs**, and they follow the same rule: a
   * container's inspection, the Swarm's nodes and its services all reach one
   * host, so `serverId` comes first in every one of them.
   *
   * Two routes in that controller group are keyed **nowhere on purpose**. The
   * join commands (`GET /cluster/add-worker` / `add-manager`) mint a live Swarm
   * token, so they are fetched when someone asks and never cached under a key a
   * background refetch could reach; `endpoints/docker.ts` note 5 says why. And
   * `GET /cluster/nodes` — dockerode's raw `listNodes` — is a second reading of
   * `swarmNodes` that adds nothing the table shows and throws rather than
   * answering `undefined` off a Swarm, so nothing calls it.
   */
  docker: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "docker"] as const,
    containers: (organizationId: OrganizationScope, serverId: string | null) =>
      [...org(organizationId), "docker", serverId, "containers"] as const,
    /** One container's `docker inspect` document. */
    config: (
      organizationId: OrganizationScope,
      serverId: string | null,
      containerId: string,
    ) =>
      [
        ...org(organizationId),
        "docker",
        serverId,
        "config",
        containerId,
      ] as const,
    /** One Service's running containers, found by the Service. */
    ofService: (
      organizationId: OrganizationScope,
      serviceType: WorkloadServiceType,
      serviceId: string,
    ) =>
      [
        ...org(organizationId),
        "docker",
        "service",
        serviceType,
        serviceId,
        "containers",
      ] as const,
    /** `docker node ls` on this host — the Swarm it belongs to, if any. */
    swarmNodes: (organizationId: OrganizationScope, serverId: string | null) =>
      [...org(organizationId), "docker", serverId, "swarm-nodes"] as const,
    /** `docker service ls` on this host. Docker's answer, not Cloudgate's. */
    swarmServices: (
      organizationId: OrganizationScope,
      serverId: string | null,
    ) =>
      [...org(organizationId), "docker", serverId, "swarm-services"] as const,
    byApp: (
      organizationId: OrganizationScope,
      serverId: string | null,
      appName: string,
      appType: string,
    ) =>
      [
        ...org(organizationId),
        "docker",
        serverId,
        "by-app",
        appName,
        appType,
      ] as const,
    stackTasks: (
      organizationId: OrganizationScope,
      serverId: string | null,
      appName: string,
    ) =>
      [...org(organizationId), "docker", serverId, "tasks", appName] as const,
    /** `docker service ps <appName>` — an Application's Swarm tasks. */
    serviceTasks: (
      organizationId: OrganizationScope,
      serverId: string | null,
      appName: string,
    ) =>
      [
        ...org(organizationId),
        "docker",
        serverId,
        "service-tasks",
        appName,
      ] as const,
  },

  deployments: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "deployments"] as const,
    byApplication: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "deployments",
        "by-application",
        applicationId,
      ] as const,
    byCompose: (organizationId: OrganizationScope, composeId: string) =>
      [...org(organizationId), "deployments", "by-compose", composeId] as const,
    logs: (organizationId: OrganizationScope, deploymentId: string) =>
      [...org(organizationId), "deployments", deploymentId, "logs"] as const,
  },

  /**
   * A domain belongs to a service, and there is no `GET /domains` — so unlike
   * every other group here there is no `list`, only the two by-parent reads
   * (`domains.controller.ts`). `all` is the invalidation unit.
   */
  domains: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "domains"] as const,
    byApplication: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "domains",
        "by-application",
        applicationId,
      ] as const,
    byCompose: (organizationId: OrganizationScope, composeId: string) =>
      [...org(organizationId), "domains", "by-compose", composeId] as const,
    byBucket: (organizationId: OrganizationScope, bucketId: string) =>
      [...org(organizationId), "domains", "by-bucket", bucketId] as const,
  },

  /**
   * A connected provider's repositories and branches.
   *
   * These reach the provider's own API over the network on every miss, so a
   * source picker asks for them when someone opens it — not on the chance they
   * might. The branch list is keyed by the **repository key**, because switching
   * repository must not show the previous one's branches while the new list is in
   * flight (`endpoints/git-providers.ts` explains what that key is).
   */
  gitProviders: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "git-providers"] as const,
    /** The base rows — every connection, whatever its kind. */
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "git-providers", "list"] as const,
    connections: (organizationId: OrganizationScope, kind: string) =>
      [...org(organizationId), "git-providers", kind] as const,
    repositories: (
      organizationId: OrganizationScope,
      kind: string,
      connection: string,
    ) =>
      [
        ...org(organizationId),
        "git-providers",
        kind,
        connection,
        "repositories",
      ] as const,
    branches: (
      organizationId: OrganizationScope,
      kind: string,
      connection: string,
      repository: string,
    ) =>
      [
        ...org(organizationId),
        "git-providers",
        kind,
        connection,
        "branches",
        repository,
      ] as const,
  },

  /**
   * The two Organization-wide lists a service's configuration form picks from:
   * where a build pushes its image, and which key clones a custom git source.
   * F15 and F13 own the screens that manage them; these are the reads.
   */
  registries: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "registries"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "registries", "list"] as const,
  },

  sshKeys: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "ssh-keys"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "ssh-keys", "list"] as const,
  },

  /**
   * The Organization's notification channels (F15).
   *
   * **One list, twelve kinds.** `GET /notifications` answers with every channel
   * whatever its type, each carrying its own connection row, so there is no
   * per-kind list key to hold — a Slack channel and an email one arrive in the
   * same array and a create of either invalidates the same list.
   */
  notifications: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "notifications"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "notifications", "list"] as const,
  },

  /**
   * The Organization's AI providers, and the models one of them offers (F15).
   *
   * `models` is keyed by the **API URL** and nothing else, because
   * `POST /ai/models` takes a URL and a key and stores nothing: the key is not
   * part of the identity of the answer, and putting a credential in a query key
   * would write it into every devtools panel and every cache dump.
   */
  ai: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "ai"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "ai", "list"] as const,
    models: (organizationId: OrganizationScope, apiUrl: string) =>
      [...org(organizationId), "ai", "models", apiUrl] as const,
  },

  /**
   * The seven child tables an Application's advanced tabs read (F10).
   *
   * Every one of them is keyed **by the owning service**, because that is how
   * all seven list routes are shaped — `?serviceId=&serviceType=` for mounts and
   * volume backups, `?scheduleType=&serviceId=` for schedules, `?id=&type=` for
   * patches, `?applicationId=` for the three networking tables, and a path
   * segment for rollbacks and previews. There is no organization-wide list of any
   * of them, so there is no `list` key here, only `all` as the invalidation unit
   * and one by-owner read each.
   *
   * Ports, redirects and security used to be **absent rather than empty** — they
   * had no list route at all — and gained one later.
   * They are keyed by
   * `applicationId` and not by a `serviceId`, deliberately: those three tables
   * hang off `application` alone and have no Compose equivalent, so a key that
   * said `by-service` would imply a read that does not exist.
   */
  mounts: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "mounts"] as const,
    byService: (organizationId: OrganizationScope, serviceId: string) =>
      [...org(organizationId), "mounts", "by-service", serviceId] as const,
  },

  ports: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "ports"] as const,
    byApplication: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "ports",
        "by-application",
        applicationId,
      ] as const,
  },

  redirects: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "redirects"] as const,
    byApplication: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "redirects",
        "by-application",
        applicationId,
      ] as const,
  },

  security: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "security"] as const,
    byApplication: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "security",
        "by-application",
        applicationId,
      ] as const,
  },

  rollbacks: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "rollbacks"] as const,
    byApplication: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "rollbacks",
        "by-application",
        applicationId,
      ] as const,
  },

  previewDeployments: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "preview-deployments"] as const,
    byApplication: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "preview-deployments",
        "by-application",
        applicationId,
      ] as const,
  },

  schedules: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "schedules"] as const,
    byService: (organizationId: OrganizationScope, serviceId: string) =>
      [...org(organizationId), "schedules", "by-service", serviceId] as const,
  },

  /**
   * A Service's Health tab: `GET /service-health/:serviceType/:id`,
   * one entry per page of Incident history under the Service's key.
   */
  serviceHealth: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "service-health"] as const,
    /** The TCP picker's options; under `byService`, so it drops with the summary. */
    publishedPorts: (
      organizationId: OrganizationScope,
      serviceType: string,
      serviceId: string,
    ) =>
      [
        ...org(organizationId),
        "service-health",
        serviceType,
        serviceId,
        "published-ports",
      ] as const,
    byService: (
      organizationId: OrganizationScope,
      serviceType: string,
      serviceId: string,
    ) =>
      [
        ...org(organizationId),
        "service-health",
        serviceType,
        serviceId,
      ] as const,
    /**
     * `GET /environments/:id/health`, under `service-health` rather
     * than the Environment so a check's write drops it with the Service's own.
     * No Service kind is called `environment`, so it cannot meet `byService`.
     */
    environment: (organizationId: OrganizationScope, environmentId?: string) =>
      environmentId === undefined
        ? ([...org(organizationId), "service-health", "environment"] as const)
        : ([
            ...org(organizationId),
            "service-health",
            "environment",
            environmentId,
          ] as const),
    page: (
      organizationId: OrganizationScope,
      serviceType: string,
      serviceId: string,
      page: number,
    ) =>
      [
        ...org(organizationId),
        "service-health",
        serviceType,
        serviceId,
        { page },
      ] as const,
  },

  /** A Service's Traces tab: `GET /traces/:serviceId?serviceType=`. */
  traces: {
    byService: (
      organizationId: OrganizationScope,
      serviceType: string,
      serviceId: string,
    ) => [...org(organizationId), "traces", serviceType, serviceId] as const,
    /** This viewer's Trace store frame: `GET /traces/:serviceId/frame`. */
    frame: (organizationId: OrganizationScope, serviceId: string) =>
      [...org(organizationId), "traces", "frame", serviceId] as const,
  },

  volumeBackups: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "volume-backups"] as const,
    byService: (organizationId: OrganizationScope, serviceId: string) =>
      [
        ...org(organizationId),
        "volume-backups",
        "by-service",
        serviceId,
      ] as const,
  },

  /**
   * A patch list, and the two reads of the *repository* behind it. The repo
   * reads are keyed by entity and then by path, because `repo/file` answers with
   * the patch's content when one exists — so the same path returns something
   * different once a patch is saved for it, and the key has to be invalidated
   * with the patch list.
   */
  patches: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "patches"] as const,
    byEntity: (organizationId: OrganizationScope, entityId: string) =>
      [...org(organizationId), "patches", "by-entity", entityId] as const,
    repo: (organizationId: OrganizationScope, entityId: string) =>
      [...org(organizationId), "patches", entityId, "repo"] as const,
    repoFile: (
      organizationId: OrganizationScope,
      entityId: string,
      filePath: string,
    ) =>
      [
        ...org(organizationId),
        "patches",
        entityId,
        "repo",
        "file",
        filePath,
      ] as const,
  },

  /** The Organization's Cloud accounts and their last check. */
  cloudAccounts: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "cloud-accounts"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "cloud-accounts", "list"] as const,
  },

  /** Where a volume backup is written. F15 owns managing these; this is the read. */
  destinations: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "destinations"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "destinations", "list"] as const,
    /**
     * What is in the bucket under a prefix — the restore picker's listing —
     * as listed from `serverId`; `null` is this Cloudgate host.
     */
    objects: (
      organizationId: OrganizationScope,
      destinationId: string,
      prefix: string,
      serverId: string | null,
    ) =>
      [
        ...org(organizationId),
        "destinations",
        destinationId,
        "objects",
        prefix,
        serverId,
      ] as const,
  },

  /**
   * Traefik's own files. Keyed by Server rather than by service: the directory
   * walk and the file read both reach a **host**, and `serverId` being null is
   * the built-in one — a real key, not a missing one.
   */
  traefik: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "traefik"] as const,
    directories: (organizationId: OrganizationScope, serverId: string | null) =>
      [...org(organizationId), "traefik", "directories", serverId] as const,
    file: (
      organizationId: OrganizationScope,
      serverId: string | null,
      path: string,
    ) => [...org(organizationId), "traefik", "file", serverId, path] as const,
    /** Whether one Server's Traefik writes an Access log. */
    requestLogging: (organizationId: OrganizationScope, serverId: string) =>
      [...org(organizationId), "traefik", "requests", serverId] as const,
    /**
     * What Traefik last said about one Application's routers — keyed by the
     * Application and not by Server, unlike its two neighbours above, because
     * the question is "is *this* Application being routed" and the backend
     * already knows which host answers it.
     */
    configStatus: (organizationId: OrganizationScope, applicationId: string) =>
      [
        ...org(organizationId),
        "traefik",
        "config-status",
        applicationId,
      ] as const,
  },

  /**
   * *Buy a Server* (ADR-0071). Under `org` though neither answer is the
   * Organization's own: both are gated on the caller's `server` permission
   * in the active Organization, so a switch must ask again.
   */
  boughtServers: {
    offer: (organizationId: OrganizationScope) =>
      [...org(organizationId), "bought-servers", "offer"] as const,
    catalogue: (organizationId: OrganizationScope) =>
      [...org(organizationId), "bought-servers", "catalogue"] as const,
    today: (
      organizationId: OrganizationScope,
      serverType: string,
      location: string,
      backups = false,
      storageGb: number | null = null,
    ) =>
      [
        ...org(organizationId),
        "bought-servers",
        "today",
        serverType,
        location,
        backups,
        storageGb,
      ] as const,
    /** The Organization's Bought Servers not made yet. */
    purchases: (organizationId: OrganizationScope) =>
      [...org(organizationId), "bought-servers", "purchases"] as const,
    /** The Bought Server behind one Server: its stage, lines and prices. */
    server: (organizationId: OrganizationScope, id: string) =>
      [...org(organizationId), "bought-servers", "server", id] as const,
    /** The sizes one Bought Server can move to; under its key, so a change refreshes them. */
    sizes: (organizationId: OrganizationScope, id: string) =>
      [
        ...org(organizationId),
        "bought-servers",
        "server",
        id,
        "sizes",
      ] as const,
  },

  servers: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "servers"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "servers", "list"] as const,
    detail: (organizationId: OrganizationScope, serverId: string) =>
      [...org(organizationId), "servers", serverId] as const,
    /** Both of these touch the host over SSH — never refetch them in the
     * background, only when someone asks. */
    validate: (organizationId: OrganizationScope, serverId: string) =>
      [...org(organizationId), "servers", serverId, "validate"] as const,
    audit: (organizationId: OrganizationScope, serverId: string) =>
      [...org(organizationId), "servers", serverId, "audit"] as const,
    /**
     * A host's cards and free cards — `null` is the platform host, a
     * real key. Tenant-scoped, unlike `instanceGpu`: the read is open to
     * anyone who may create a Service there, so it is the organization's.
     */
    gpuCounts: (organizationId: OrganizationScope, serverId: string | null) =>
      [...org(organizationId), "servers", "gpu-counts", serverId] as const,
  },

  /**
   * A Server's own telemetry samples (F13), and F14's three additions.
   *
   * Keyed by Server **and by window**, because `limit` changes what the route
   * returns and a 50-sample read and a 500-sample read of the same host are two
   * different answers, not one answer at two resolutions.
   *
   * **The two request keys are the reason this group is worth reading.** Both
   * routes are `POST`s that read nothing and write nothing — they are queries
   * whose filter is too big for a query string — so **the body is the key**, and
   * it goes in whole. Keying them by anything less would serve one filter's rows
   * under another filter's name, and the failure would look like the backend
   * ignoring a filter rather than like a cache hit. `dateRange` is in there for
   * the same reason, which is also why the range control's bounds are rounded
   * (see `components/console/time-range.tsx`): a `start` that moves every
   * millisecond is a key that never hits.
   */
  monitoring: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "monitoring"] as const,
    serverMetrics: (
      organizationId: OrganizationScope,
      serverId: string,
      limit: string,
    ) =>
      [
        ...org(organizationId),
        "monitoring",
        "server",
        serverId,
        limit,
      ] as const,
    /**
     * One service's container samples on one host — a Server's id, or
     * `"web-server"` for the machine Cloudgate runs on. That host
     * has no `server` row to name, and `serverMetrics` above has taken the same
     * placeholder in the same position; a key component cannot be
     * absent, and the route is asked about the host by *omitting* the id.
     */
    containerMetrics: (
      organizationId: OrganizationScope,
      serverId: string,
      appName: string,
      limit: string,
    ) =>
      [
        ...org(organizationId),
        "monitoring",
        "containers",
        serverId,
        appName,
        limit,
      ] as const,
    /** The Requests page's Server picker. */
    requestTargets: (organizationId: OrganizationScope) =>
      [...org(organizationId), "monitoring", "requests", "targets"] as const,
    /** One read of an Access log; the whole query is the key. */
    requestsRead: (organizationId: OrganizationScope, query: unknown) =>
      [
        ...org(organizationId),
        "monitoring",
        "requests",
        "read",
        query,
      ] as const,
    /** One read of a Service's Requests tab; the whole query is the key. */
    serviceRequestsRead: (
      organizationId: OrganizationScope,
      serviceId: string,
      query: unknown,
    ) =>
      [
        ...org(organizationId),
        "monitoring",
        "requests",
        "service",
        serviceId,
        query,
      ] as const,
  },

  /**
   * How this instance is doing (F14), and whether Traefik is logging requests.
   *
   * **Under `instance`, not under `org`** — the same reasoning F06 used for the
   * sign-in screen's SSO read. Postgres, Traefik and the access-log switch belong
   * to *this deployment of Cloudgate*, and there is exactly one of each however
   * many Organizations it holds; filing them per-Organization would refetch the
   * same two probes under a new key on every switch and imply the answer could
   * differ. The **read** is gated by the caller's role, which is not the same as
   * the data being the tenant's.
   */
  instanceHealth: () => [...instance, "infrastructure-health"] as const,
  traefikRequests: () => [...instance, "traefik", "requests"] as const,

  /**
   * How *this deployment of Cloudgate* is set up (F16).
   *
   * All of it is under `instance` on F14's argument, extended: there is exactly
   * one `web_server_settings` row, one version string, one Traefik container and
   * one Docker daemon on the platform host however many Organizations the
   * instance holds. Filing them per-Organization would refetch the same answer
   * under a new key on every switch **and imply the answer could differ**, which
   * is the more expensive half of the mistake — somebody would eventually change
   * a build-concurrency setting in one Organization expecting the other to keep
   * its own.
   *
   * The two that take a `serverId` keep it in the key anyway, because the routes
   * do: `null` is the platform host and is a real key, not a missing one — the
   * rule `keys.traefik` and `keys.docker` already follow.
   */
  webServerSettings: () => [...instance, "web-server"] as const,
  /**
   * What Traefik last said about the console's **own** routers (H-61).
   *
   * Under `instance` and not beside `keys.traefik` above, even though the route
   * is `/traefik/config-status/console`: the two files behind it are
   * instance-wide, the route takes instance authority rather than an
   * Organization role, and — the reason that decides it — assigning the console
   * domain is what triggers a fresh check, and that mutation already drops the
   * whole `instance` root through `invalidate.instanceSettings()`. Filing it
   * anywhere else would leave the card showing the verdict on the router the
   * save just replaced.
   */
  consoleRouterStatus: () =>
    [...instance, "traefik", "console-router"] as const,
  instanceVersion: () => [...instance, "version"] as const,
  /** `GET /settings/about`, which carries the instance mode. */
  instanceAbout: () => [...instance, "about"] as const,
  instanceReleaseTag: () => [...instance, "release-tag"] as const,
  instanceIp: () => [...instance, "ip"] as const,
  /**
   * The GitHub Releases comparison. A `POST` used as a query — F14's precedent,
   * and it never refetches on its own: it reaches api.github.com over the
   * network to answer.
   */
  instanceUpdate: () => [...instance, "update-data"] as const,
  instanceGpu: (serverId: string | null) =>
    [...instance, "gpu", serverId] as const,
  /**
   * Declared beside observed, for one host. Under `instance` on the same
   * argument as everything else in this block: it describes *this deployment of
   * Cloudgate* and a machine it can reach, and the read being role-gated is not
   * the data being the tenant's. `serverId` stays in the key by the rule above —
   * `null` is the platform host and is a real key, not a missing one.
   */
  instanceRuntimeInfo: (serverId: string | null) =>
    [...instance, "runtime-info", serverId] as const,
  dockerDiskUsage: () => [...instance, "docker-disk-usage"] as const,
  logCleanup: () => [...instance, "log-cleanup"] as const,

  /**
   * Traefik's three named files, its environment, its dashboard flag and its
   * published ports (F16).
   *
   * Split from `keys.traefik` above deliberately, and the split is the
   * controller's rather than ours: those two routes take a `serverId` and walk a
   * **directory**, these read the platform host's Traefik *container*. Three of
   * the four here take a `serverId` the screens only ever pass as null, and it is
   * in the key so that stays true by construction rather than by habit.
   */
  traefikConfig: (kind: string) =>
    [...instance, "traefik", "config", kind] as const,
  /**
   * The platform host's Traefik **directory walk and file reads**, which are the
   * same two routes `keys.traefik` above holds — and are keyed separately here
   * on purpose.
   *
   * F10 reads them per Application, so its key hangs off the Organization. The
   * Platform screen reads the *instance's* Traefik, and it has to invalidate with
   * everything else on that screen: saving `dynamic/middlewares.yml` adds a file
   * to the tree, and `invalidate.instanceSettings()` drops the `instance` root
   * and nothing under `org`. Found by driving it — the file appeared on disk and
   * not in the browser beside it.
   */
  instanceTraefikFiles: () => [...instance, "traefik", "files"] as const,
  instanceTraefikFile: (path: string) =>
    [...instance, "traefik", "files", path] as const,
  traefikEnv: (serverId: string | null) =>
    [...instance, "traefik", "env", serverId] as const,
  traefikDashboard: (serverId: string | null) =>
    [...instance, "traefik", "dashboard", serverId] as const,
  traefikPorts: (serverId: string | null) =>
    [...instance, "traefik", "ports", serverId] as const,
  /**
   * A machine's DNS-01 setup. Under `instance` beside Traefik's env, and
   * for its reason: saving it recreates that machine's Traefik, so
   * `invalidate.instanceSettings()` must drop it with the container reads.
   */
  traefikDnsChallenge: (serverId: string | null) =>
    [...instance, "traefik", "dns-challenge", serverId] as const,

  /**
   * The Organization's certificates (F16), and the roles it can hand out.
   *
   * `roleStatements` is the odd one and sits under `instance` on the same
   * argument as `instanceHealth`: `GET /custom-roles/statements` returns
   * `rbac/access-control.ts` verbatim — a constant of the build, not a row —
   * and the read being gated by a session does not make the answer the tenant's.
   * The **roles** themselves are rows in one Organization and are keyed as such.
   */
  certificates: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "certificates"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "certificates", "list"] as const,
  },

  roleStatements: () => [...instance, "role-statements"] as const,

  roles: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "roles"] as const,
    list: (organizationId: OrganizationScope) =>
      [...org(organizationId), "roles", "list"] as const,
    /** Who holds one — `GET /custom-roles/:roleName/members`. */
    members: (organizationId: OrganizationScope, roleName: string) =>
      [...org(organizationId), "roles", "members", roleName] as const,
  },

  /**
   * **The licensed surfaces (F18).** Every one of them is the Organization's,
   * with two exceptions at the bottom that are the instance's for the same
   * reason `roleStatements` is.
   *
   * `license.status` is the most-read key in the app after the session: every
   * enterprise section's `LicenseGate` subscribes to it, so it is one key with
   * many readers rather than one read per section. It is under `org` and not
   * `instance` because a licence belongs to a **tenant** here — phase 49 moved
   * it off the owner's user row — so switching Organization really can change
   * the answer, and a cached `true` handed to the wrong tenant would unlock
   * five screens that then 403 on every read.
   */
  license: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "license"] as const,
    status: (organizationId: OrganizationScope) =>
      [...org(organizationId), "license", "status"] as const,
    settings: (organizationId: OrganizationScope) =>
      [...org(organizationId), "license", "settings"] as const,
  },

  /**
   * The audit trail, keyed **by its filters**, because every one of them is an
   * input to the response — a narrowed table is a different question, not the
   * same one refetched. The filters are serialised by the caller into one
   * stable string so the key stays comparable.
   */
  auditLogs: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "audit-logs"] as const,
    page: (organizationId: OrganizationScope, filters: string) =>
      [...org(organizationId), "audit-logs", filters] as const,
  },

  sso: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "sso"] as const,
    providers: (organizationId: OrganizationScope) =>
      [...org(organizationId), "sso", "providers"] as const,
    trustedOrigins: (organizationId: OrganizationScope) =>
      [...org(organizationId), "sso", "trusted-origins"] as const,
    redirectUri: (organizationId: OrganizationScope) =>
      [...org(organizationId), "sso", "redirect-uri"] as const,
    provenDomains: (organizationId: OrganizationScope) =>
      [...org(organizationId), "sso", "proven-domains"] as const,
  },

  scim: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "scim"] as const,
    providers: (organizationId: OrganizationScope) =>
      [...org(organizationId), "scim", "providers"] as const,
  },

  /**
   * Forward-auth, keyed by **`serverId` first** wherever a target is involved —
   * `keys.docker` and `keys.traefik`'s rule, and for the same reason: `null` is
   * the local Traefik and is a real target rather than a missing id.
   *
   * `domain` is the exception and is keyed by the domain instead, because that
   * half of the controller is not about a server at all: it is reached from an
   * Application's own screen and is not licensed.
   */
  forwardAuth: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "forward-auth"] as const,
    targets: (organizationId: OrganizationScope) =>
      [...org(organizationId), "forward-auth", "targets"] as const,
    providers: (organizationId: OrganizationScope) =>
      [...org(organizationId), "forward-auth", "providers"] as const,
    settings: (organizationId: OrganizationScope, serverId: string | null) =>
      [...org(organizationId), "forward-auth", serverId, "settings"] as const,
    domain: (organizationId: OrganizationScope, domainId: string) =>
      [...org(organizationId), "forward-auth", "domain", domainId] as const,
  },

  /**
   * Billing. Under `org` throughout, because a subscription belongs to the
   * tenant — phase 48 made the same move licences did.
   *
   * **`products` is a tenant key even though the catalogue is the instance's**,
   * and that is deliberate rather than sloppy: `getProducts` returns the
   * catalogue *and* `currentPlan` / `isAnnualCurrent` / `currentPriceAmount`
   * for the calling Organization, so the response is not the same answer for
   * two tenants. Splitting it would mean two requests for one route.
   */
  billing: {
    all: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing"] as const,
    subscription: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "subscription"] as const,
    products: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "products"] as const,
    invoices: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "invoices"] as const,
    canCreateServer: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "can-create-server"] as const,
    standing: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "standing"] as const,
    plan: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "plan"] as const,
    attachedOrganizations: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "attached-organizations"] as const,
    attachedPlan: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "attached-plan"] as const,
    upgradePreview: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "upgrade-preview"] as const,
    downgradeImpact: (organizationId: OrganizationScope) =>
      [...org(organizationId), "billing", "downgrade-impact"] as const,
  },

  /**
   * The **Template catalogue** is under `instance`: the backend reads one
   * catalogue for the whole instance (`CLOUDGATE_TEMPLATES_URL`), so it is the
   * same answer for every Organization and every person, and switching
   * Organization cannot change it.
   *
   * A **setup form** is not: it answers the Organization's Projects,
   * Environments and Servers, so it is tenant data under `org`.
   */
  templates: {
    all: () => [...instance, "templates"] as const,
    catalogue: () => [...instance, "templates", "catalogue"] as const,
    setupForm: (
      organizationId: OrganizationScope,
      templateId: string,
      projectId: string,
    ) =>
      [
        ...org(organizationId),
        "templates",
        "setup",
        templateId,
        projectId,
      ] as const,
  },
};
