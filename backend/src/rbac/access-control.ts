import { createAccessControl } from 'better-auth/plugins/access';

/**
 * Access-control statements — every resource and its possible actions. The
 * first five (organization, member, invitation, team, ac) are better-auth
 * organization plugin defaults; the rest are platform resources.
 */
export const statements = {
  // better-auth organization plugin defaults
  organization: ['update', 'delete'],
  member: ['read', 'create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],

  // Core resources (free tier)
  /**
   * `update` is its own action, not covered by `create` or `delete`.
   * `service` below and `docker` below that are the same shape, and this is
   * the `service` defect one resource over.
   *
   * **There was no project action a write consulted.** `PATCH /projects/:id`
   * carries no `@RequirePermission`, so its only gate was
   * `ProjectsService.findOne` → `PermissionService.checkProjectAccess(ctx,
   * 'read', id)` — and that method's `'read'` branch deliberately skips
   * `checkPermission` altogether, because there is no `project: ['read']`
   * statement to consult. So the gate in front of the write was the member
   * row's `accessedProjects` and nothing else, for every role including a
   * licensed custom one holding no `project` action at all. The two
   * `projectTag` writes, `POST` and `DELETE /tags/:id/projects/:projectId`,
   * carry no decorator either and run the same read-level check.
   *
   * **What that write reaches is the part that makes this worse than the
   * `service` one.** `updateProjectSchema` is `createProjectSchema.partial()`,
   * so `PATCH /projects/:id` writes `project.env` — an `encryptedText` column
   * that `prepareEnvironmentVariables` (`docker/docker.utils.ts`) merges into
   * the environment of **every Service in every Environment under the Project**
   * at its next deploy. `checkProjectAccess`'s row-level branch consults
   * `accessedProjects` only, so the write crosses both of the other two
   * entitlement columns: a caller granted one Environment of a Project, and one
   * Service in it, could inject a variable into the Services and Environments
   * they were deliberately refused.
   *
   * **Who decided that this is allowed to reach that far: ADR-0014.**
   * The paragraph above is a subject of its own, and it was left open —
   * naming the level is not the same decision as bounding what the write
   * reaches. ADR-0014 takes it, and takes it the way that changes no code:
   * **the grant means what it says**, so holding `project: ['update']` is
   * authority over everything under the Project, and an inherited write is
   * bounded by the grant naming the parent rather than by the narrowest
   * entitlement beneath it. Nothing here narrows as a result; what the ADR adds
   * is that the radius is citable, which is what the issue asked for.
   *
   * Two words above are looser than the mechanism, and the ADR states it
   * exactly: `prepareEnvironmentVariables` resolves `${{project.KEY}}`
   * references against the parent rows rather than merging keys into them, so
   * the write cannot put a variable into a Service that never named one. What
   * it does instead is change what every reference already written resolves to
   * at that Service's next deploy — a refused Service's
   * `DB_PASSWORD=${{project.DB_PASSWORD}}` included — and, since an
   * unresolvable reference throws, renaming or removing a key fails the next
   * deploy of every Service that referenced it. Either way the effect lands on
   * rows `accessedProjects` does not name, so "inject" overstates the shape and
   * not the reach.
   *
   * **Rejected, and it is ADR-0014's own trade-off rather than a convention:**
   * bounding the write by every child's entitlement. The operator most likely
   * to hold a Project-level variable is the one entitled to a subset of the
   * Project, so the common case would start failing, and the refusal could not
   * say which row was missing without making the route an oracle for the
   * Project's shape (§2.2, ADR-0008).
   *
   * The consequence stated positively: **the level is now expressible.**
   * `project: ['update']` means "may rewrite this Project's row", and holding
   * no `project` action means read-and-nothing-else — which is what a
   * `project`-less role already looked like and was not.
   *
   * **Scope: the Project's own row, and nothing beneath it.** `update` gates
   * `PATCH /projects/:id` and the two `projectTag` assignment writes. It
   * pointedly does **not** gate `DELETE /projects/:id`, which already requires
   * `project: ['delete']` at the guard — the service level's carve-out, and
   * refusing a delete for want of `update` would make "may retire a Project but
   * not rewrite it" unsayable in the act of creating the level. Nor does it
   * gate anything an Environment or a Service owns: those have their own
   * statements and their own actions. That is the scope of the *gate*, and not
   * of the write's effect — ADR-0014 is the difference between the two, and it
   * is deliberate that they are not the same shape.
   *
   * **This narrows existing custom roles, deliberately, and there is no
   * migration.** The `docker` argument, unchanged and quoted in the `docker`
   * statement below: writing `update` into every stored `organization_role`
   * that could reach the route changes nobody's behaviour and leaves the hole
   * standing until an operator edits each role by hand, which is the hole. The
   * operator-facing note is at
   * `PermissionService.checkProjectAccess`.
   *
   * **`memberRole` does *not* get this action, which is where `project` parts
   * company with `service` and with `environment` above.** The reasoning is at
   * {@link memberRole}'s `project` line; the short form is that
   * `accessedProjects` does not bound the write, and the base member holds no
   * other project mutation to be inconsistent with.
   *
   * **Rejected: reusing `create`.** `checkProjectAccess` skips its row-level
   * branch entirely for `'create'` — creating a Project is an org-level act
   * with no id to scope — so an update passing `'create'` would lose the
   * `accessedProjects` check that is the only row-level gate this resource
   * has.
   *
   * **Rejected: one broad `manage`.** The `docker` reasoning for two named
   * actions over one, unchanged.
   */
  project: ['create', 'update', 'delete'],
  /**
   * `update` is its own action, separate from `read`. `docker: ['read']`
   * one statement down is the same shape, and this is the same answer.
   *
   * **`read` was the only service action a write consulted.** `PATCH
   * /compose/:id`, `PATCH /applications/:id`, the `PATCH /{engine}/:id` family
   * across all six engines, their eight `:id/environment` twins, and
   * `/applications/:id/drop` and `/applications/:id/refresh-token` carry no
   * `@RequirePermission` at all, so their only gate was
   * `PermissionService.checkServiceAccess`, whose `action` parameter defaults
   * to `'read'` — and `memberRole` held `service: ['read']`. Granting a member
   * `accessedServices: [id]`, which reads as "can see and operate this
   * service", therefore also granted "can replace its compose YAML wholesale".
   * Eighteen routes, enumerated in
   * `test/coding-standards/route-permissions.spec.ts`.
   *
   * The consequence worth stating positively: **the level is now
   * expressible.** Before this, no role — custom or otherwise — could be
   * granted "see and operate this service, but do not rewrite its definition",
   * because there was no action a write could ask for that a read did not
   * already carry. After it, `service: ['read']` means read.
   *
   * **That sentence also fixes the action's scope, and the scope is narrower
   * than "every write".** `update` gates writes of a Service's *definition* —
   * its own row, its environment, its published port, its dropped source, its
   * webhook secret, and the configuration child rows that have no statement of
   * their own (ports, redirects, basic-auth users, mounts, patches). It
   * pointedly does **not** gate *operating* the workload: `start`, `stop`,
   * `reload`, `deploy`, `changeStatus`, `rebuild` and `removeContainers` each
   * already require `deployment: ['create']`, which is the statement a custom
   * role is granted so it may run a stack it may not redefine. Requiring both
   * would have made the level above unsayable in the very act of creating it —
   * "operate" would have needed the rewrite action. It was tried, and
   * `compose.e2e-spec.ts` said so: the assertion that a role holding
   * `volumeBackup: ['restore']` and the lifecycle statement can finish its
   * restore went red. `ComposeService.removeContainers` had argued the shape of
   * that gate before the `service: update` level existed.
   *
   * **This narrows existing custom roles, deliberately, and there is no
   * migration.** A stored `organization_role` holding `service: ['read']`
   * loses the definition writes and keeps every read — and keeps every
   * lifecycle verb its other statements already carry — until an operator adds
   * `update`. The `docker` statement argues the alternative down at length one
   * statement below and the argument is unchanged here: writing `update` into
   * every row that already held `read` changes nobody's behaviour and leaves
   * the hole standing until an operator edits each role by hand, which is the
   * hole. See `PermissionService.checkServiceAccess` for the operator-facing
   * note.
   *
   * **All three static roles hold it, `memberRole` included, so their
   * behaviour is unchanged.** That is the part that needs justifying, because
   * granting the new action to the base member is what keeps the eighteen
   * routes open to them. The base member role is already not read-only on a
   * service it is entitled to: it holds
   * `deployment: ['read', 'create', 'cancel']`, `volume` with create and
   * delete, and `backup`/`volumeBackup`/`schedule` with full CRUD. A member who
   * can trigger a deploy, add and drop its volumes and restore a backup over it
   * can already change what runs, so withholding "edit the compose YAML" alone
   * would be a distinction the rest of the role does not make — and it would
   * silently remove a member's ability to edit their own stack, which is a
   * feature removal rather than a fix.
   *
   * **One item is gone from that list and it was the weakest of them.**
   * This paragraph used to lead with `envVars: ['read', 'write']` and read "a
   * member who can write env vars and trigger a deploy can already change what
   * runs". `envVars` was declared, granted by every static role, and consulted
   * by nothing — and the eight `PATCH /{engine}/:id/environment` twins it named
   * are in the very set of eighteen this `update` action was being added to
   * gate. So the citation was both dead and circular: the env write it offered
   * as independent evidence is `service: ['update']`. The remaining four grants
   * are the argument, and they carried it on their own.
   *
   * **Rejected: reusing `create` for updates.** `create`'s id argument is a
   * *project* id at all five of its pre-existing sites, and
   * `checkServiceAccess` branches on `action === 'create'` to check
   * `accessedProjects` rather than `accessedServices`. An update's id is a
   * service id, so reusing `create` would send every update through the wrong
   * entitlement column — which is what `PatchService` and `PatchRepoService`
   * were already doing, and what the `service: update` change moved to
   * `'update'` for exactly this reason.
   *
   * **Rejected: one broad `manage`.** The `docker` reasoning for preferring two
   * named actions over one, unchanged.
   *
   * **`call` spends on an AI model**: the Gateway admits an Agent
   * key whose Agent holds it on that AI model, by `checkPermission` plus
   * `checkServiceAccess`. It is its own action rather than `read` because
   * reading a Service's config must not buy GPU spend, and it does nothing on a
   * plain Application. Owner and admin hold it; the base member does not, and a
   * stored custom role lacks it until an operator grants it.
   */
  service: ['create', 'read', 'update', 'delete', 'call'],
  /**
   * `update` is its own action, separate from `read`. `service` above
   * is the same shape one resource over, so the argument is the same and
   * only the blast radius differs.
   *
   * **`read` was the only environment action a write consulted.** `PATCH
   * /environments/:id` carries no `@RequirePermission`, so its only gate was
   * `EnvironmentsService.findOwned` →
   * `PermissionService.checkEnvironmentAccess(ctx, id, 'read')`. Granting a
   * role `environment: ['read']` plus `accessedEnvironments: [id]`, which
   * reads as "can see this Environment and the services in it", therefore also
   * granted "can rename it and rewrite the environment variables every service
   * in it inherits".
   *
   * `updateEnvironmentSchema` is `createEnvironmentSchema.omit({ projectId:
   * true }).partial()`, so that route writes `environment.env` — an
   * `encryptedText` column `prepareEnvironmentVariables`
   * (`docker/docker.utils.ts`) resolves the `${{environment.KEY}}` references
   * of every Service in the Environment against, at that Service's next
   * deploy. Not the Environment's own name alone.
   *
   * **How far that reaches is ADR-0014's, one level down from `project`
   * above.** The same decision covers both: the grant means what it
   * says, so `environment: ['update']` is authority over everything in that
   * Environment, and the write is not bounded by `accessedServices`. Here the
   * grant is the tighter of the two — `checkEnvironmentAccess`'s row-level
   * branch requires *this* Environment's id in `accessedEnvironments`, which
   * is an explicit per-Environment grant naming the rows the write reaches,
   * and it is why `memberRole` holds this action and holds no `project` one.
   *
   * The consequence stated positively: **the level is now expressible.**
   * Before this, no role could be granted "see this Environment and the
   * services in it, but do not reconfigure it". After it, `environment:
   * ['read']` means read.
   *
   * **Scope: the Environment's own row.** `update` gates `PATCH
   * /environments/:id` and nothing else. It pointedly does **not** gate
   * `DELETE /environments/:id`, which already requires `environment:
   * ['delete']` at the guard — that is the service level's carve-out, and
   * `test/projects/service-cascade-delete.e2e-spec.ts`'s `deployer` role holds
   * `environment: ['read', 'delete']` precisely to exercise the per-child
   * gate: requiring `update` to delete would refuse a role deliberately
   * granted the delete.
   *
   * **This narrows existing custom roles, deliberately, and there is no
   * migration** — the `docker` argument two statements down, unchanged. The
   * operator-facing note is at `PermissionService.checkEnvironmentAccess`.
   *
   * **`memberRole` holds it, so the base member's behaviour is unchanged**, and
   * that is the half needing justification. See {@link memberRole}'s
   * `environment` line: the write is bounded by the per-Environment grant a
   * member was explicitly given, and the member already holds
   * `service: ['update']` on the Services inside it — which is the statement
   * that gates each of those Services' own `env` write, and the reason the
   * `envVars` this sentence used to cite alongside it was gating nothing.
   * This is the opposite answer to `project` above, on purpose, and
   * both lines say why.
   */
  environment: ['create', 'read', 'update', 'delete'],
  /**
   * `write` is its own action, not folded into `read`.
   *
   * One action meant a **read** statement authorized five destructive verbs:
   * `containerOp` gates `stop`, `kill`, `start`, `restart` and `docker rm -f`
   * on it, so a licensed custom role granted `docker: ['read']` could
   * `docker rm -f` a managed container while being refused
   * `POST /settings/traefik/reload`, whose surface is `requireOwnerOrAdmin`.
   * The destructive path was the more permissive of the two.
   *
   * **This narrows existing custom roles, deliberately.** A role holding
   * `docker: ['read']` today loses the five destructive verbs and the
   * file upload — six routes — and keeps every read. There
   * is no migration granting them the new action: the alternative — writing
   * `write` into every `organization_role` row that already held `read` —
   * changes nobody's behaviour and leaves the hole standing until an operator
   * edits each role by hand, which is the hole. Narrowing is the fix; see
   * `docker-ops.service.ts`'s `containerOp` for the operator-facing note.
   *
   * Two actions rather than a separate `manage`, and not split by verb
   * (`start`/`restart` under read, the rest under the new one): `traefikFiles`
   * already spells this exact shape `['read', 'write']`, and a `start` that a
   * read statement authorizes is still a caller changing the state of somebody
   * else's workload.
   */
  docker: ['read', 'write'],
  sshKeys: ['read', 'create', 'delete'],
  gitProviders: ['read', 'create', 'delete'],
  traefikFiles: ['read', 'write'],
  // **Deliberately no `api` here.** It was declared in this object,
  // granted `['read']` by `ownerRole` and `adminRole`, listed as `[]` on
  // `memberRole`, and consulted **nowhere in `src`** — no `@RequirePermission`,
  // no `checkPermission`, and nothing that assembles a resource key at runtime
  // either: `composedCreateStatements` is the only producer of a statement
  // object the guards did not spell out, and it yields `service`, `domain` and
  // `volume`.
  //
  // The three routes it reads as if it gated are personal rather than
  // organizational. `POST`, `GET` and `DELETE /users/me/api-keys` carry no
  // decorator, hand the caller's own headers to better-auth's `createApiKey`,
  // `listApiKeys` and `deleteApiKey`, and are authorized by the session on the
  // caller's own user row — there is no organization-level question here for a
  // statement to answer.
  //
  // Making it mean something was the other option, and it is rejected for the
  // reason `settings/account/api-keys-card.tsx` already had to state on screen:
  // an api-key session carries no `activeOrganizationId`, so a key acts as the
  // whole person in whichever Organization happens to be their default. A gate
  // in front of minting one would be a boundary the key does not respect once
  // issued, which is the same untruth as the toggle.
  //
  // The half of the argument this shares with `envVars` and `logs` — why a
  // declared-and-unconsulted statement is worse than a dead line, and why no
  // stored role needs migrating — is at their note below.

  // Enterprise-only resources (custom roles only)
  volume: ['read', 'create', 'delete'],
  deployment: ['read', 'create', 'cancel'],
  // **Deliberately no `projectEnvVars` or `environmentEnvVars` here.**
  // Both were declared in this object and granted in all three static roles,
  // and **nothing in `src` ever consulted either** — no `@RequirePermission`,
  // no `checkPermission`. The writes they read as if they gated ride on
  // `PATCH /projects/:id` and `PATCH /environments/:id`, which are behind
  // `project: ['update']` and `environment: ['update']`, so the real gate has
  // always been those two statements. The cost was not the two dead lines: this
  // object is what `GET /custom-roles/statements` serves and what the roles
  // screen renders, so an operator was offered two toggles that did nothing —
  // and withholding one told them they had restricted something they had not.
  //
  // Pointing the routes at them was the other option — splitting `env` out of
  // `updateProjectSchema`/`updateEnvironmentSchema` into its own gated
  // operation — and ADR-0014 rejects it: an inherited write is bounded by the
  // grant that names the parent, so the finer grain is not wanted.
  //
  // A stored `organization_role` still carrying either key keeps working.
  // `PermissionService.resolveRole` hands the merged grants to `ac.newRole`,
  // and better-auth's `authorize` iterates the *requested* resources, so a
  // granted key nothing ever requests is never looked at — pinned in
  // `test/rbac/access-control.spec.ts` rather than assumed. Re-declaring
  // either one is what that spec's sweep of unconsulted statements exists to
  // stop.

  // **Deliberately no `envVars` or `logs` here either.** The `api` finding
  // one and two resources over, and its own note put all three — these two and
  // `api` above — into the sweep's baseline rather than deciding them. Both
  // were declared in this object, granted `['read', 'write']` and `['read']` by
  // all three static roles, and consulted **nowhere in `src`**.
  //
  // `envVars` — a *Service's* own variables — is that case exactly. The
  // writes it read as if it gated are `PATCH /applications/:id/environment`,
  // `PATCH /compose/:id/environment` and the six `PATCH
  // /{engine}/:id/environment` twins, which the `service: update` change put
  // behind `service: ['update']`, so the real gate has always been that
  // statement. It was worse than dead, which a later sweep found: the argument
  // for granting the base member `service: ['update']` cited `envVars: ['read',
  // 'write']` as proof the role was already not read-only on a Service — a
  // grant nothing consulted, covering the very eight routes `update` was being
  // added for. The rest of that argument stands without it and is what {@link
  // statements}' `service` line now cites.
  //
  // **`logs` needed a decision rather than a deletion, and the decision is
  // still to delete.** A finer grain over log access is imaginable and this is
  // the statement it would use, so the reason is ADR-0007 and ADR-0008 rather
  // than tidiness. Log access is already authorized by *entitlement*, on both
  // transports: a deployment log is addressed by `deploymentId` and resolved
  // through `checkServiceAccess` (ADR-0007), with `deployment: ['read']` on its
  // HTTP twin; a container log is addressed by container and authorized against
  // the Service that owns it, or by `docker: ['read']` when it belongs to no
  // Service (ADR-0008). Requiring this statement *as well* is the shape
  // ADR-0008's first consequence rejects by name — "requiring both would deny
  // every base member the logs of their own services" — one column over: a
  // licensed custom role entitled to a Service and not granted `logs` would
  // lose the logs of that Service, a feature removal delivered inside a fix.
  // And settling how a statement-shaped gate composes with an id-addressed
  // socket and the managed-container rule is an amendment to two ADRs, not a
  // line in this object. The third option is the one already ruled out:
  // this object is what `GET /custom-roles/statements` serves and what the
  // roles grid renders, so an operator withholding `logs: ['read']` from a
  // custom role was told they had restricted something they had not.
  //
  // **No migration for any of the three.** Re-verified against the installed
  // better-auth 1.6.33 rather than carried over from the earlier sweep:
  // `createAccessControl(s)` keeps `s` only as its own `.statements` and hands
  // `newRole`'s argument straight to `role()`, and `role.authorize` iterates
  // `Object.entries(request)` — the **requested** resources — looking each up
  // in the role's own grant map. A granted key nothing ever requests is never
  // read, so a stored `organization_role` still carrying `api`, `envVars` or
  // `logs` answers every request this vocabulary can express exactly as it did.
  // `test/rbac/access-control.spec.ts` pins that, and the frontend's
  // `pruneEmpty` is what keeps such a role re-savable once the grid stops
  // rendering the key.

  /**
   * `read` gates every `GET` in `servers.controller.ts`. It also gated the
   * `serverId` arm of `POST /templates/preview` and `POST /templates/deploy`,
   * which rendered the named Server's `ipAddress` into the generated hosts and
   * env values; they asked for `service: ['create']` alone until then, so a
   * licensed custom role denied `read` here was still answered a Server's
   * address by them. Both routes were removed with the `template.toml` reader
   * (#1364, ADR-0066): a Template is set up into an Environment, never onto a
   * Server the request names.
   *
   * The platform host is deliberately outside this statement: it has no `server`
   * row, so an absent `serverId` — as everywhere else in the product — is
   * ADR-0008's "there is no server row to find" and
   * answers to instance authority where it answers to anything (ADR-0013),
   * never to this line.
   */
  server: ['read', 'create', 'delete'],
  registry: ['read', 'create', 'delete'],
  /**
   * A **Cloud account** (CONTEXT.md): `read` lists them and their last
   * check and never calls the cloud, `create` connects one, `update` changes
   * its credential, checks it again and hands out its setup template, `delete`
   * removes it. Owners and admins hold all four through the bypass below, a
   * licensed custom role may be granted any, and the base member and both
   * agent roles hold none — connecting an account that spends money is never
   * a default.
   */
  cloudAccount: ['read', 'create', 'update', 'delete'],
  certificate: ['read', 'create', 'update', 'delete'],
  backup: ['read', 'create', 'update', 'delete', 'restore'],
  volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
  schedule: ['read', 'create', 'update', 'delete'],
  domain: ['read', 'create', 'delete'],
  destination: ['read', 'create', 'delete'],
  notification: ['read', 'create', 'update', 'delete'],
  tag: ['read', 'create', 'update', 'delete'],
  monitoring: ['read'],
  auditLog: ['read'],
} as const;

/**
 * The resources `PermissionService.checkPermission` does not check for an
 * **owner or admin**: a request made only of these passes for those two roles
 * without consulting their grant map. It feeds that bypass and nothing else.
 *
 * This said "for static roles (owner/admin/member)" once, and the member
 * half was never true: `checkPermission` bypasses on `role === 'owner' ||
 * role === 'admin'` alone, so a member — and now an Agent on `agentReader` or
 * `agentOperator` — falls straight through to `role.authorize` on every one of
 * these, which is exactly why `memberRole` below spells out
 * `deployment: ['read', 'create', 'cancel']` and why the agent roles can hold
 * `deployment` and `domain` unlicensed. The name is historical:
 * what makes a resource "enterprise" is that a custom role, which needs a
 * licence, is the only other kind of role that is checked on it with anything
 * other than a static grant.
 */
export const enterpriseOnlyResources = new Set<string>([
  'volume',
  'deployment',
  'server',
  'registry',
  'cloudAccount',
  'certificate',
  'backup',
  'volumeBackup',
  'schedule',
  'domain',
  'destination',
  'notification',
  'tag',
  'monitoring',
  'auditLog',
]);

/**
 * The four resources better-auth's organization plugin owns — membership and
 * organization lifecycle, which are kept out of custom roles because they are
 * not delegable grants.
 *
 * **Declared in {@link statements} so a custom role can be *refused* them, not
 * so anything can ask for them.** `CustomRolesService`'s `validatePermissions`
 * is the refusal and `PermissionGrid` is the annotation; no
 * `@RequirePermission` and no `checkPermission` in `backend/src` names one, and
 * `test/rbac/access-control.spec.ts`' `UNCONSULTED` sweep is what holds that
 * true — its exemption list is these four and nothing else.
 *
 * **They are enforced, and not from here.** better-auth's organization
 * plugin checks all four itself, against its own `defaultRoles` keyed on the
 * `member.role` column: read at
 * `node_modules/better-auth/dist/plugins/organization/has-permission.mjs` in
 * the installed 1.6.33, `hasPermission` starts from `input.options.roles ||
 * defaultRoles`, and its one branch that would read an `organizationRole` row
 * is behind `options.dynamicAccessControl?.enabled && options.ac` —
 * `createAuth`'s `organization({ … })` passes no `roles`, no `ac` and no
 * `dynamicAccessControl`. So the plugin never sees the grant map
 * `PermissionService.resolveRole` builds, and this `ac` is a separate
 * `createAccessControl` instance that only `PermissionService` consults.
 *
 * **Here rather than in `custom-roles.service.ts`, where it was
 * `INTERNAL_RESOURCES`**, which gave `PermissionService` a second
 * reader: `toDeclaredGrants` drops a stored grant of one of these, and
 * `custom-roles.service.ts` already imports from `permission.service.ts`, so
 * reading it the other way round would be a cycle. This module is the
 * vocabulary and imports nothing in `src`, and `enterpriseOnlyResources` below
 * is the same shape for the same reason.
 *
 * Order is the served order: `getStatements` hands this out as
 * `internalResources` and the console's builder disables exactly these rows.
 */
export const internalResources: readonly string[] = [
  'organization',
  'invitation',
  'team',
  'ac',
];

export const ac = createAccessControl(statements);

/**
 * Owner role — full access to everything
 */
export const ownerRole = ac.newRole({
  organization: ['update', 'delete'],
  member: ['read', 'create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
  // `project` and `environment` are outside `enterpriseOnlyResources` too, so
  // these two lines are the whole of what authorizes an owner's Save on the
  // Project and Environment screens, and their tag assignments.
  project: ['create', 'update', 'delete'],
  // As with `docker` below, `service` is not in `enterpriseOnlyResources`, so
  // this line is the whole of what authorizes an owner's Save on an
  // Application, a compose stack or a database. `call` is mostly moot
  // here, since a person has no Gateway credential.
  service: ['create', 'read', 'update', 'delete', 'call'],
  environment: ['create', 'read', 'update', 'delete'],
  // `docker` is not in `enterpriseOnlyResources`, so `checkPermission`'s
  // owner/admin bypass never answers a docker check — this line is the whole of
  // what authorizes one. Omitting the `write` would refuse an owner
  // the console's own Stop, Kill, Restart and Remove buttons.
  docker: ['read', 'write'],
  sshKeys: ['read', 'create', 'delete'],
  gitProviders: ['read', 'create', 'delete'],
  traefikFiles: ['read', 'write'],
  volume: ['read', 'create', 'delete'],
  deployment: ['read', 'create', 'cancel'],
  server: ['read', 'create', 'delete'],
  registry: ['read', 'create', 'delete'],
  cloudAccount: ['read', 'create', 'update', 'delete'],
  certificate: ['read', 'create', 'update', 'delete'],
  backup: ['read', 'create', 'update', 'delete', 'restore'],
  volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
  schedule: ['read', 'create', 'update', 'delete'],
  domain: ['read', 'create', 'delete'],
  destination: ['read', 'create', 'delete'],
  notification: ['read', 'create', 'update', 'delete'],
  tag: ['read', 'create', 'update', 'delete'],
  monitoring: ['read'],
  auditLog: ['read'],
});

/**
 * Admin role — same as owner but cannot delete the organization
 */
export const adminRole = ac.newRole({
  organization: ['update'],
  member: ['read', 'create', 'update', 'delete'],
  invitation: ['create', 'cancel'],
  team: ['create', 'update', 'delete'],
  ac: ['create', 'read', 'update', 'delete'],
  // As on `ownerRole`, and for the same reason.
  project: ['create', 'update', 'delete'],
  // As on `ownerRole`, and for the same reason `docker` is spelled out below.
  // `call` as on `ownerRole`.
  service: ['create', 'read', 'update', 'delete', 'call'],
  environment: ['create', 'read', 'update', 'delete'],
  // As on `ownerRole`: `docker` is outside `enterpriseOnlyResources`, so this
  // line is the whole of what authorizes an admin's Stop, Kill, Restart and
  // Remove.
  docker: ['read', 'write'],
  sshKeys: ['read', 'create', 'delete'],
  gitProviders: ['read', 'create', 'delete'],
  traefikFiles: ['read', 'write'],
  volume: ['read', 'create', 'delete'],
  deployment: ['read', 'create', 'cancel'],
  server: ['read', 'create', 'delete'],
  registry: ['read', 'create', 'delete'],
  cloudAccount: ['read', 'create', 'update', 'delete'],
  certificate: ['read', 'create', 'update', 'delete'],
  backup: ['read', 'create', 'update', 'delete', 'restore'],
  volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
  schedule: ['read', 'create', 'update', 'delete'],
  domain: ['read', 'create', 'delete'],
  destination: ['read', 'create', 'delete'],
  notification: ['read', 'create', 'update', 'delete'],
  tag: ['read', 'create', 'update', 'delete'],
  monitoring: ['read'],
  auditLog: ['read'],
});

/**
 * Member role (free tier) — the base permissions.
 * Members can read projects/services/environments they have access to and
 * change the services among them, but cannot create or delete a service, and
 * cannot reach admin resources. Org-level enterprise resources are not
 * available to the base member role.
 *
 * "Read-only base permissions" is what this said once, and it was never
 * true: `deployment: ['create']` and full CRUD on `backup`, `volumeBackup`,
 * `schedule` and `volume` were all already here. What changed is that the
 * mutation the role does hold on a Service is now *named* —
 * `service: ['update']` rather than a write riding on `['read']`. (The first
 * version of this sentence led with `envVars: ['read', 'write']`, which was
 * deleted as a statement nothing consulted; the four grants left are the ones
 * that made it untrue.)
 *
 * `environment: update` did the same for an Environment and, for the first time
 * in this series, **took something away**: the base member no longer rewrites a
 * Project. The two lines carry the argument, and it is per resource rather than
 * inherited — a member's relationship to an Environment is not their
 * relationship to a Project, because a Project spans Environments the member's
 * own grant does not name.
 */
export const memberRole = ac.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ['read'],
  /**
   * **Still empty, and this is the one place `project` answers the `service`
   * member question differently.** `project: ['update']` is deliberately
   * withheld, which *changes* current behaviour rather than preserving it: a
   * base member entitled to a Project can `PATCH /projects/:id` today and
   * after this cannot, and the same for `POST`/`DELETE
   * /tags/:id/projects/:projectId`. Three routes, and the loss is stated
   * rather than discovered — `test/rbac/rbac.e2e-spec.ts` asserts each of the
   * three refusals by name.
   *
   * Two facts make it the right answer here and the wrong one for `service`
   * and `environment`:
   *
   * - **`accessedProjects` does not bound the write.** `PATCH /projects/:id`
   *   writes `project.env`, which every Service in every Environment under the
   *   Project can *reference by name* — `prepareEnvironmentVariables` builds
   *   its output from the Service's own keys alone and reads this row only to
   *   resolve `${{project.KEY}}`, so nothing is merged downward and nothing new
   *   appears in a Service that never named it (ADR-0014). The
   *   escalation is what that resolution answers: the row-level branch of
   *   `PermissionService.checkProjectAccess` consults `accessedProjects` alone,
   *   so a member granted one Environment and one Service of a Project changes
   *   what every `${{project.KEY}}` already written under it resolves to at
   *   that Service's next deploy — including in the Environments and Services
   *   they were deliberately refused — and, because an unresolvable reference
   *   throws, fails those deploys outright by removing a key one of them named.
   *   That is an escalation across the boundary the member row exists to draw,
   *   not a level that wants naming — and it is why the `service` argument "a
   *   member who can trigger a deploy … can already change what runs" does not
   *   transfer: there it was the *same* service, here it is other people's.
   * - **There is no other project mutation to be inconsistent with.** The `service`
   *   argument for granting the base member `service: ['update']` was that the
   *   role was already not read-only on a service — `deployment`, `volume`,
   *   `backup`, `volumeBackup`. On a Project the base member holds *nothing*: no
   *   `create`, no `delete`, and not even `environment: ['create']`, so they
   *   cannot add an Environment to one. `project: []` coherently says "a
   *   member works inside a Project and does not administer it", and the one
   *   write that contradicted it was the defect.
   *
   * The capability is not gone, it is now sayable: an owner or admin holds
   * `project: ['update']`, and a licensed custom role can be granted it.
   */
  project: [],
  // `update` and not `create`/`delete`: a member changes the services
  // they are entitled to and cannot mint or destroy one. Adding it is what
  // keeps the eighteen undecorated routes that used to ride on `['read']` open
  // to them, so this line is the whole of why the `service: update` change is
  // not a feature removal.
  service: ['read', 'update'],
  /**
   * `update` added so the base member's behaviour is unchanged: a
   * member entitled to an Environment could rename it and rewrite its shared
   * `env` before, and still can. The `project` line above withholds the
   * equivalent, and the difference between the two is the whole of the
   * member question:
   *
   * - **The grant bounds the write.** `environment.env` reaches the Services
   *   in *this* Environment, and `checkEnvironmentAccess`'s row-level branch
   *   requires this Environment's id in `accessedEnvironments` — an explicit,
   *   per-Environment grant. `project.env` reaches Environments that grant
   *   does not name.
   * - **The role is already not read-only here.** A member holds
   *   `service: ['read', 'update']` on the Services in an Environment granted
   *   to them — which is what gates each of those Services' own `env` write,
   *   and so covers the `envVars` this bullet used to cite beside it —
   *   so withholding "rename the Environment they work in" would be a
   *   distinction the rest of the role does not make. The `service` argument,
   *   and here it does transfer.
   *
   * `create` and `delete` stay off: a member works in the Environments they
   * are granted and cannot mint or destroy one.
   */
  environment: ['read', 'update'],
  // Unchanged by the `docker: write` change, and the reason
  // `container-access.service.ts` does not also require `docker:read` for a
  // *managed* container: a base member holds no docker action at all, so every
  // container route is already refused them and stays refused. Their own
  // service's logs come through the entitlement branch instead.
  docker: [],
  sshKeys: [],
  gitProviders: [],
  traefikFiles: [],
  // Service-level enterprise resources — member can do everything within services they have access to
  volume: ['read', 'create', 'delete'],
  deployment: ['read', 'create', 'cancel'],
  backup: ['read', 'create', 'update', 'delete', 'restore'],
  volumeBackup: ['read', 'create', 'update', 'delete', 'restore'],
  schedule: ['read', 'create', 'update', 'delete'],
  domain: ['read', 'create', 'delete'],
  monitoring: ['read'],
  // Org-level enterprise resources — member cannot manage these
  server: [],
  registry: [],
  cloudAccount: [],
  certificate: [],
  destination: [],
  notification: [],
  tag: ['read'],
  auditLog: [],
});

/**
 * **Reader** — the base role an **Agent** is created on, and one of the two
 * roles only an Agent ever holds (ADR-0023).
 *
 * Exactly the four reads the MCP tool surface's read tools declare, and nothing
 * else: no `ac` (no gate consults it), no `monitoring`, no `tag`, and above all
 * no `docker` — ADR-0024's standing prohibition on a tool running a command in
 * a Managed container is pinned by neither agent role ever holding a docker
 * statement. A resource this map does not name is refused by `role.authorize`
 * outright, so leaving a resource out is how it is withheld.
 *
 * Static and unlicensed on purpose. A custom role would stop resolving the day
 * a licence lapsed (`PermissionService.resolveRole`), taking production's
 * deploy Agent down with it, and it would erase the agent-only role name that
 * tells an audit row's Agent from its person.
 */
export const agentReaderRole = ac.newRole({
  service: ['read'],
  environment: ['read'],
  deployment: ['read'],
  domain: ['read'],
});

/**
 * **Operator** — {@link agentReaderRole} plus deploying and cancelling.
 *
 * `deployment: ['create']` is the lifecycle statement (CONTEXT.md, Service), so
 * in the statement vocabulary it also buys a database rebuild, compose
 * `removeContainers` and a rollback. Only the absence of a tool keeps an Agent
 * from those, which ADR-0023 states rather than leaves to be discovered.
 */
export const agentOperatorRole = ac.newRole({
  service: ['read'],
  environment: ['read'],
  deployment: ['read', 'create', 'cancel'],
  domain: ['read'],
});

/**
 * **Caller** — spends on an AI model through the Gateway, and nothing else.
 *
 * `service: ['call']` alone: no read of any kind, so a key sitting in a
 * Service's env can spend on the AI models its Agent is granted and can neither
 * read nor deploy anything. Neither other agent role gains `call` — an operator
 * who wants both creates two Agents. Static and unlicensed for
 * {@link agentReaderRole}'s reasons.
 *
 * Holding no read statement is not enough to keep it off `/mcp`, because a
 * row-scoped tool (`list_projects`, …) declares no statement; the dispatcher
 * reads {@link GATEWAY_ONLY_ROLES} instead.
 */
export const agentCallerRole = ac.newRole({
  service: ['call'],
});

/**
 * The three roles an Agent may hold, and the only three. A person never holds
 * one — so the role an audit row records says whether its actor was a person
 * or an Agent — and an Agent never holds anything else (`member-role.ts` is the
 * one writer that keeps both halves true).
 */
export const AGENT_ROLES = [
  'agentReader',
  'agentOperator',
  'agentCaller',
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

/**
 * The agent roles whose key reaches no MCP tool: `tools/list` answers
 * empty and every `tools/call` is refused, row-scoped tools included. Their
 * key's one use is the Gateway.
 */
export const GATEWAY_ONLY_ROLES: readonly AgentRole[] = ['agentCaller'];

/** Whether `role` is one of the roles only an Agent holds. */
export function isAgentRole(role: string): role is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(role);
}
