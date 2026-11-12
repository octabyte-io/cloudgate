import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ac,
  adminRole,
  enterpriseOnlyResources,
  internalResources,
  memberRole,
  ownerRole,
  statements,
} from '../../src/rbac/access-control';
import type { Permissions } from '../../src/rbac/permission.service';

/** Every file under `dir`, recursively. */
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

/**
 * The resources `backend/src` actually gates on, read out of the two shapes a
 * gate is ever written in — `@RequirePermission('resource', …)` and
 * `checkPermission(ctx, { resource: […] })`. Both are matched as text rather
 * than through the type system on purpose: what is under test is whether any
 * call site *names* the statement, and a statement no call site names is
 * exactly what compiles fine and gates nothing.
 */
function resourcesConsultedInSrc(): Set<string> {
  const named = new Set<string>();
  const decorated = /@RequirePermission\(\s*'([A-Za-z]+)'/g;
  const asked = /checkPermission\(\s*[^,]+,\s*\{\s*([A-Za-z]+)\s*:/g;

  for (const file of walk(join(__dirname, '..', '..', 'src'))) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const [, resource] of text.matchAll(decorated)) named.add(resource);
    for (const [, resource] of text.matchAll(asked)) named.add(resource);
  }
  return named;
}

describe('access control statements and static roles', () => {
  /**
   * `service` carried three actions and none of them was `update`, so
   * every write that consulted the resource consulted `read` — the same shape
   * as `docker: ['read']` below, one resource over. `PATCH /compose/:id`,
   * `PATCH /applications/:id` and the `PATCH /{engine}/:id` family carry no
   * `@RequirePermission` at all, so `PermissionService.checkServiceAccess` was
   * their only gate and its `action` defaults to `'read'`: eighteen routes on
   * which `service: ['read']` authorized a wholesale rewrite.
   *
   * The pair of directions is what makes it provable that this is a narrowing
   * of custom roles rather than a blanket denial, and the `memberRole` block
   * further down is what makes it provable that it is not a feature removal
   * for the static roles.
   *
   * **What the action does not cover** is asserted where it can be — over HTTP,
   * in `rbac.e2e-spec.ts`. `update` gates writes of a Service's *definition*
   * and not *operating* its workload: `start`, `stop`, `reload`, `deploy`,
   * `changeStatus`, `rebuild` and `removeContainers` keep `'read'` plus their
   * own `deployment: ['create']`, because a role granted the lifecycle
   * statement so it may run a stack it may not redefine is exactly the level
   * this action exists to make expressible. Nothing about that is visible from
   * the role objects, which is why it is pinned there rather than here.
   */
  describe('the service resource', () => {
    it('carries an update action apart from read, create and delete, and call after them', () => {
      expect(statements.service).toEqual([
        'create',
        'read',
        'update',
        'delete',
        'call',
      ]);
    });

    /**
     * The triage of the `service: ['update']` change asks for this rather than
     * an assumption: `Permissions` is `{ [R in Resource]?: Action<R>[] }` over
     * `statements`, so the new action reaches `@RequirePermission` and
     * `PermissionsGuard` with nothing else edited. If the mapped type ever
     * stops deriving from `statements`, this stops compiling.
     */
    it('reaches the Permissions type the guard and the decorator take', () => {
      const required: Permissions = { service: ['update'] };

      expect(ownerRole.authorize(required).success).toBe(true);
    });

    it('refuses update to a custom role granted read alone, and still allows it read', () => {
      const readOnly = ac.newRole({ service: ['read'] });

      expect(readOnly.authorize({ service: ['read'] }).success).toBe(true);
      expect(readOnly.authorize({ service: ['update'] }).success).toBe(false);
    });

    /**
     * The other half of the narrowing, and the reason `create` was rejected as
     * the action to reuse. A custom role that already held everything
     * `statements` offered before this change still does not hold `update`, so
     * an operator adding it is a deliberate act rather than something a
     * pre-existing "full access to services" role got for free.
     */
    it('refuses update to a custom role holding every action service had before', () => {
      const preExistingFull = ac.newRole({
        service: ['create', 'read', 'delete'],
      });

      expect(preExistingFull.authorize({ service: ['create'] }).success).toBe(
        true,
      );
      expect(preExistingFull.authorize({ service: ['update'] }).success).toBe(
        false,
      );
    });

    it('allows update to a custom role granted it', () => {
      const editor = ac.newRole({ service: ['read', 'update'] });

      expect(editor.authorize({ service: ['read', 'update'] }).success).toBe(
        true,
      );
      expect(editor.authorize({ service: ['create'] }).success).toBe(false);
      expect(editor.authorize({ service: ['delete'] }).success).toBe(false);
    });
  });

  /**
   * The `service: ['update']` change, one resource over. `environment` carried
   * three actions and none of them was `update`, so the one write that
   * consulted the resource consulted `read`: `PATCH /environments/:id` carries
   * no `@RequirePermission`, so `EnvironmentsService.findOwned` was its only
   * gate and `PermissionService.checkEnvironmentAccess`'s `action` defaults to
   * `'read'`. And the route is not a rename — `updateEnvironmentSchema` carries
   * `env`, the column `prepareEnvironmentVariables` resolves every Service in
   * the Environment's `${{environment.KEY}}` references against at its next
   * deploy (ADR-0014 states the mechanism exactly; "merges into" here was
   * loose).
   *
   * The pair of directions is what makes it provable that this is a narrowing
   * of custom roles rather than a blanket denial, and the `memberRole` block
   * further down is what makes it provable that it is not a feature removal
   * for the static roles — which for `environment` it is not, and for
   * `project` it deliberately is.
   *
   * **What the action does not cover** is `DELETE /environments/:id`, and the
   * last assertion here is what pins it rather than leaving it to a docblock.
   * That route carries `environment: ['delete']` at the guard and asks
   * `checkServiceAccess(…, 'delete')` of every child, so `remove` keeps
   * `findOwned` at read level: a role granted the delete and not the update is
   * still allowed the delete. The `service` carve-out, and
   * `test/projects/service-cascade-delete.e2e-spec.ts`'s `deployer` role —
   * `environment: ['read', 'delete']`, `project: ['delete']` — is the fixture
   * that would have gone red.
   */
  describe('the environment resource', () => {
    it('carries an update action apart from create, read and delete', () => {
      expect(statements.environment).toEqual([
        'create',
        'read',
        'update',
        'delete',
      ]);
    });

    it('refuses update to a custom role granted read alone, and still allows it read', () => {
      const readOnly = ac.newRole({ environment: ['read'] });

      expect(readOnly.authorize({ environment: ['read'] }).success).toBe(true);
      expect(readOnly.authorize({ environment: ['update'] }).success).toBe(
        false,
      );
    });

    /**
     * The other half of the narrowing. A custom role that already held
     * everything `statements` offered before this change still does not hold
     * `update`, so an operator adding it is a deliberate act rather than
     * something a pre-existing "full access to environments" role got for
     * free.
     */
    it('refuses update to a custom role holding every action environment had before', () => {
      const preExistingFull = ac.newRole({
        environment: ['create', 'read', 'delete'],
      });

      expect(
        preExistingFull.authorize({ environment: ['create', 'delete'] })
          .success,
      ).toBe(true);
      expect(
        preExistingFull.authorize({ environment: ['update'] }).success,
      ).toBe(false);
    });

    it('allows update to a custom role granted it', () => {
      const editor = ac.newRole({ environment: ['read', 'update'] });

      expect(
        editor.authorize({ environment: ['read', 'update'] }).success,
      ).toBe(true);
      expect(editor.authorize({ environment: ['create'] }).success).toBe(false);
      expect(editor.authorize({ environment: ['delete'] }).success).toBe(false);
    });

    /**
     * The carve-out, as a role rather than as a route. This is the `deployer`
     * fixture's `environment` grant verbatim, and if `remove` were ever moved
     * onto `findOwnedForUpdate` the cascade-delete suite would refuse it —
     * which is exactly how the same mistake was found one resource down.
     */
    it('authorizes delete on a role holding read and delete and no update', () => {
      const deployer = ac.newRole({ environment: ['read', 'delete'] });

      expect(deployer.authorize({ environment: ['delete'] }).success).toBe(
        true,
      );
      expect(deployer.authorize({ environment: ['update'] }).success).toBe(
        false,
      );
    });
  });

  /**
   * The other half, and the more exposed of the two. `project` carried
   * `['create', 'delete']` — **no read action at all** — and
   * `PermissionService.checkProjectAccess` skips `checkPermission` entirely
   * for `'read'` because there is no statement to consult. `PATCH
   * /projects/:id` carries no `@RequirePermission`, so its only gate was
   * `ProjectsService.findOne`'s row-level `accessedProjects` check: *every*
   * role that could see a Project could rewrite it, including a custom role
   * holding no `project` action whatsoever. `POST` and `DELETE
   * /tags/:id/projects/:projectId` ran the same check.
   *
   * And `updateProjectSchema` is `createProjectSchema.partial()`, so that
   * route writes `project.env` — merged by `prepareEnvironmentVariables` into
   * every Service in **every** Environment under the Project. The row-level
   * branch consults `accessedProjects` alone, so the write crossed the other
   * two entitlement columns.
   *
   * **The `memberRole` block below is the behaviour change**, not a
   * preservation: the base member holds no `project` action after this either,
   * so three routes that answered 200 for an entitled member now answer 403.
   * `rbac.e2e-spec.ts` asserts each by name.
   */
  describe('the project resource', () => {
    it('carries an update action apart from create and delete, and still no read', () => {
      expect(statements.project).toEqual(['create', 'update', 'delete']);
    });

    /**
     * The same deliverable as for `service`, for the resource that gained its
     * first non-lifecycle action: `Permissions` is
     * `{ [R in Resource]?: Action<R>[] }` over `statements`, so the new action
     * reaches `@RequirePermission` and `PermissionsGuard` with nothing else
     * edited. If the mapped type ever stops deriving from `statements`, this
     * stops compiling.
     */
    it('reaches the Permissions type the guard and the decorator take', () => {
      const required: Permissions = {
        project: ['update'],
        environment: ['update'],
      };

      expect(ownerRole.authorize(required).success).toBe(true);
    });

    /**
     * The narrowing, in the only direction `project` has: there was no `read`
     * to grant, so the role that reached `PATCH /projects/:id` before was one
     * holding *nothing* on the resource and an `accessedProjects` entry.
     */
    it('refuses update to a custom role holding no project action', () => {
      const noProjectGrant = ac.newRole({ service: ['read'] });

      expect(noProjectGrant.authorize({ project: ['update'] }).success).toBe(
        false,
      );
    });

    it('refuses update to a custom role holding every action project had before', () => {
      const preExistingFull = ac.newRole({ project: ['create', 'delete'] });

      expect(
        preExistingFull.authorize({ project: ['create', 'delete'] }).success,
      ).toBe(true);
      expect(preExistingFull.authorize({ project: ['update'] }).success).toBe(
        false,
      );
    });

    it('allows update to a custom role granted it', () => {
      const editor = ac.newRole({ project: ['update'] });

      expect(editor.authorize({ project: ['update'] }).success).toBe(true);
      expect(editor.authorize({ project: ['create'] }).success).toBe(false);
      expect(editor.authorize({ project: ['delete'] }).success).toBe(false);
    });

    /**
     * The carve-out. `test/projects/service-cascade-delete.e2e-spec.ts`'s
     * `deployer` role holds `project: ['delete']` and no `update`, and it is
     * the only way that suite can reach the per-child gate at all — a static
     * role holding `project: ['delete']` is owner or admin, and both skip
     * every row-level check. Moving `remove` onto `findOneForUpdate` would
     * refuse a role deliberately granted the delete.
     */
    it('authorizes delete on a role holding delete and no update', () => {
      const deployer = ac.newRole({ project: ['delete'] });

      expect(deployer.authorize({ project: ['delete'] }).success).toBe(true);
      expect(deployer.authorize({ project: ['update'] }).success).toBe(false);
    });
  });

  /**
   * `docker` carried one action, and `containerOp` gated `stop`, `kill`,
   * `start`, `restart` and `docker rm -f` on it — so a **read** statement
   * authorized five destructive verbs. The narrowing is what these assert; the
   * pair below is what makes it provable that it is a narrowing rather than a
   * blanket denial.
   *
   * **A sixth verb went behind the same action later**: `uploadFileToContainer`,
   * which `docker cp`s a caller's file into the container, was the one route
   * first scoped out and left on `read`. Nothing here needed adding for it —
   * that is the point of the note, and what these assertions already covered.
   * It does widen what `write` means, from "change this container's lifecycle"
   * to also "put a file inside it", which was a decision rather than a side
   * effect: a third `docker` action whose only holder is one route was rejected
   * in favour of keeping the statement table small.
   */
  describe('the docker resource', () => {
    it('carries a write action apart from read', () => {
      expect(statements.docker).toEqual(['read', 'write']);
    });

    it('refuses write to a custom role granted read alone, and still allows it read', () => {
      const readOnly = ac.newRole({ docker: ['read'] });

      expect(readOnly.authorize({ docker: ['read'] }).success).toBe(true);
      expect(readOnly.authorize({ docker: ['write'] }).success).toBe(false);
    });

    it('authorizes the destructive verbs and the file upload on write alone, so the gate asks for one action and not two', () => {
      // Every other fixture here grants read *and* write, so all of them would
      // stay green if `containerOp` or `uploadFileToContainer` were re-tightened
      // to demand both. This one is the only thing that says which action those
      // gates are allowed to name.
      const writeOnly = ac.newRole({ docker: ['write'] });

      expect(writeOnly.authorize({ docker: ['write'] }).success).toBe(true);
      expect(writeOnly.authorize({ docker: ['read'] }).success).toBe(false);
    });

    it('allows both to a custom role granted read and write', () => {
      const full = ac.newRole({ docker: ['read', 'write'] });

      expect(full.authorize({ docker: ['read'] }).success).toBe(true);
      expect(full.authorize({ docker: ['write'] }).success).toBe(true);
    });
  });

  describe('ownerRole', () => {
    it('authorizes every action of every resource', () => {
      for (const [resource, actions] of Object.entries(statements)) {
        const result = ownerRole.authorize({ [resource]: [...actions] });
        expect({ resource, success: result.success }).toEqual({
          resource,
          success: true,
        });
      }
    });
  });

  describe('adminRole', () => {
    it('can update but not delete the organization', () => {
      expect(adminRole.authorize({ organization: ['update'] }).success).toBe(
        true,
      );
      expect(adminRole.authorize({ organization: ['delete'] }).success).toBe(
        false,
      );
    });

    it('has full access to projects and members', () => {
      expect(
        adminRole.authorize({ project: ['create', 'delete'] }).success,
      ).toBe(true);
      expect(
        adminRole.authorize({ member: ['read', 'create', 'update', 'delete'] })
          .success,
      ).toBe(true);
    });

    /**
     * `docker` is not in `enterpriseOnlyResources`, so unlike the enterprise
     * statements an admin really is authorized through `role.authorize` rather
     * than through `checkPermission`'s bypass — leaving the new action off this
     * role would refuse the console's own Stop button to an admin.
     */
    it('holds the docker write the five destructive container verbs and the file upload require', () => {
      expect(adminRole.authorize({ docker: ['read', 'write'] }).success).toBe(
        true,
      );
    });

    /**
     * `service` is not in `enterpriseOnlyResources` either, so the same thing
     * that is true of `docker` above is true here: an admin is authorized
     * through `role.authorize` rather than through `checkPermission`'s bypass,
     * and omitting the `service: ['update']` action would refuse an admin the
     * Save button on every Application, compose stack and database.
     */
    it('holds every service action, update included', () => {
      expect(
        adminRole.authorize({
          service: ['create', 'read', 'update', 'delete'],
        }).success,
      ).toBe(true);
    });

    /**
     * `project` and `environment` are outside `enterpriseOnlyResources` too,
     * so omitting the `update` action would refuse an admin the Save button
     * on the Project and Environment screens and the tag picker on the
     * Projects list — the same failure mode `docker` and `service` have above,
     * and the reason both static roles had to be edited.
     */
    it('holds every project and environment action, update included', () => {
      expect(
        adminRole.authorize({
          project: ['create', 'update', 'delete'],
          environment: ['create', 'read', 'update', 'delete'],
        }).success,
      ).toBe(true);
    });
  });

  describe('memberRole', () => {
    it('can read services and environments but not create projects', () => {
      expect(memberRole.authorize({ service: ['read'] }).success).toBe(true);
      expect(memberRole.authorize({ environment: ['read'] }).success).toBe(
        true,
      );
      expect(memberRole.authorize({ project: ['create'] }).success).toBe(false);
      expect(memberRole.authorize({ project: ['delete'] }).success).toBe(false);
    });

    it('cannot manage members, invitations, or org-level enterprise resources', () => {
      expect(memberRole.authorize({ member: ['create'] }).success).toBe(false);
      expect(memberRole.authorize({ invitation: ['create'] }).success).toBe(
        false,
      );
      expect(memberRole.authorize({ server: ['create'] }).success).toBe(false);
      expect(memberRole.authorize({ registry: ['read'] }).success).toBe(false);
    });

    /**
     * `envVars: ['read', 'write']` and `logs: ['read']` were the other two
     * assertions here and went with the statements. Both passed on a
     * grant no route ever asked for, which is the shape that made a reader
     * believe the statements were load-bearing. The Service-level mutations
     * that really are the member's are the three left, plus the set enumerated
     * in "keeps every mutation it held before the service update landed" below.
     */
    it('can manage service-level enterprise resources within accessible services', () => {
      expect(memberRole.authorize({ deployment: ['create'] }).success).toBe(
        true,
      );
      expect(memberRole.authorize({ volume: ['create'] }).success).toBe(true);
      expect(memberRole.authorize({ monitoring: ['read'] }).success).toBe(true);
    });

    /**
     * Already refused every container route today, and stays refused — by the
     * five destructive verbs and by the upload alike, which is why neither
     * narrowing touches the built-in member.
     */
    it('holds no docker action at all, read or write', () => {
      expect(memberRole.authorize({ docker: ['read'] }).success).toBe(false);
      expect(memberRole.authorize({ docker: ['write'] }).success).toBe(false);
    });

    /**
     * The regression the `service: ['update']` change is one line away from
     * being. Granting the new action to the base member is what keeps the
     * eighteen undecorated routes — the Service's own row, its environment, its
     * dropped source and its webhook secret — open to a member entitled to the
     * service, and withholding it would have removed a member's ability to edit
     * their own stack. `create` and `delete` stay off: a member changes the
     * services they are entitled to and cannot mint or destroy one.
     */
    it('holds the service update the undecorated definition writes require, and still no create or delete', () => {
      expect(
        memberRole.authorize({ service: ['read', 'update'] }).success,
      ).toBe(true);
      expect(memberRole.authorize({ service: ['create'] }).success).toBe(false);
      expect(memberRole.authorize({ service: ['delete'] }).success).toBe(false);
    });

    /**
     * Asserted per resource rather than trusted to the role diff, because the
     * change's triage names this as the regression risk: every one of these is
     * a mutation the base member holds on a service it is entitled to, and
     * every one of them is reached through a route that also passes through
     * `checkServiceAccess`. If a future narrowing of `service` takes one of
     * them away, the failure lands here and names the resource.
     *
     * **Three entries are gone and were the reason the two statement deletions
     * were tracked on their own rather than made in passing:** `projectEnvVars:
     * ['write']` and `environmentEnvVars: ['write']`, and `envVars: ['write']`.
     * Nothing in `src` consulted any of the three, so all three assertions
     * passed on a grant no route ever asked for — they read as evidence that
     * the statements were load-bearing while pinning nothing at all. What
     * actually gates the writes they looked like they covered is `project:
     * ['update']` and `environment: ['update']` for the parent rows asserted by
     * name further down this block, and `service: ['update']` for a Service's
     * own `env`, asserted two blocks up.
     */
    it('keeps every mutation it held before the service update landed', () => {
      const mutations: Permissions[] = [
        { deployment: ['create', 'cancel'] },
        { volume: ['create', 'delete'] },
        { backup: ['create', 'update', 'delete', 'restore'] },
        { volumeBackup: ['create', 'update', 'delete', 'restore'] },
        { schedule: ['create', 'update', 'delete'] },
        { domain: ['create', 'delete'] },
      ];

      expect(
        mutations.filter(
          (permission) => !memberRole.authorize(permission).success,
        ),
      ).toEqual([]);
    });

    /**
     * The answer for `environment`, and it is the one `service` got: the base
     * member could rename an Environment granted to them and rewrite the `env`
     * every Service in it can *reference by name*, and still can. Reference,
     * not inherit — `prepareEnvironmentVariables` returns the Service's own
     * keys and reads this row only to resolve `${{environment.KEY}}`
     * (ADR-0014). `create` and `delete` stay off — a member works in the
     * Environments they are granted and cannot mint or destroy one.
     *
     * The two facts that make this the right answer here and the wrong one for
     * `project` below are in `memberRole`'s own two lines: the write is
     * bounded by the per-Environment grant `checkEnvironmentAccess` requires,
     * and the role already holds `service: ['update']` on the Services inside
     * it — which is what gates each of those Services' own `env` write, and so
     * covers the `envVars` this block used to cite beside it.
     */
    it('holds the environment update the undecorated definition write requires, and still no create or delete', () => {
      expect(
        memberRole.authorize({ environment: ['read', 'update'] }).success,
      ).toBe(true);
      expect(memberRole.authorize({ environment: ['create'] }).success).toBe(
        false,
      );
      expect(memberRole.authorize({ environment: ['delete'] }).success).toBe(
        false,
      );
    });

    /**
     * **The one place this series takes something away**. `project`
     * stays empty, so a base member entitled to a Project can no longer
     * `PATCH /projects/:id`, `POST /tags/:id/projects/:projectId` or
     * `DELETE` the same — three routes that answered 200 before, refused by
     * name in `rbac.e2e-spec.ts`.
     *
     * Deliberate, and argued at `memberRole`'s `project` line: `PATCH
     * /projects/:id` writes `project.env`, which every Service in every
     * Environment under the Project can *reference by name* — nothing is merged
     * downward (ADR-0014) — while `checkProjectAccess`'s row-level branch
     * consults `accessedProjects` alone. So a member granted one Environment
     * and one Service of a Project changed what every `${{project.KEY}}`
     * already written in the Environments and Services they were refused
     * individually resolves to at the next deploy, and could fail those deploys
     * by removing a key one of them named. The `service` argument "the role is
     * already not read-only here" does not transfer either: on a Project the
     * base member holds no other mutation at all, not even `environment:
     * ['create']` to add an Environment to one.
     */
    it('holds no project action at all, the newly added update included', () => {
      expect(memberRole.authorize({ project: ['update'] }).success).toBe(false);
      expect(memberRole.authorize({ project: ['create'] }).success).toBe(false);
      expect(memberRole.authorize({ project: ['delete'] }).success).toBe(false);
    });
  });

  describe('enterpriseOnlyResources', () => {
    it('marks deployment and server as enterprise-only but not project', () => {
      expect(enterpriseOnlyResources.has('deployment')).toBe(true);
      expect(enterpriseOnlyResources.has('server')).toBe(true);
      expect(enterpriseOnlyResources.has('project')).toBe(false);
      expect(enterpriseOnlyResources.has('service')).toBe(false);
    });

    /**
     * Load-bearing for `docker: ['write']`: the bypass in
     * `PermissionService.checkPermission` fires only when *every* requested
     * resource is enterprise-only, so a `docker` check is answered by the
     * role's own grants for owner and admin alike. That is why the new action
     * had to be added to both static roles, and why the upload needed nothing
     * added: they already hold it.
     */
    it('does not mark docker enterprise-only, so no static role bypasses a docker check', () => {
      expect(enterpriseOnlyResources.has('docker')).toBe(false);
    });

    it('every enterprise-only resource is a declared statement', () => {
      for (const resource of enterpriseOnlyResources) {
        expect(Object.keys(statements)).toContain(resource);
      }
    });
  });

  /**
   * `projectEnvVars` and `environmentEnvVars` were declared in
   * `statements`, granted in all three static roles, and consulted **nowhere
   * in `src`** — no `@RequirePermission`, no `checkPermission`. The writes they
   * read as if they gated ride on `PATCH /projects/:id` and
   * `PATCH /environments/:id`, which are now behind `project: ['update']` and
   * `environment: ['update']`, so the real gate was always somewhere else.
   *
   * The reason a dead statement is worse than a dead line: `statements` is what
   * `GET /custom-roles/statements` serves and what the roles grid renders, so
   * both appeared as toggles an operator could set to no effect — and one of
   * them was *asserted* by the `memberRole` block above, which is the shape
   * that makes a reader believe it is load-bearing. Deleting them is
   * ADR-0014's corollary: the finer grain they gestured at is not
   * wanted, because an inherited env write is bounded by the grant that names
   * the parent.
   *
   * So this block is the negative, pinned two ways — the specific one, that
   * these two keys are gone, and the general one at the end of this file, that
   * no statement survives which nothing consults. The block below is the
   * same negative for the three statements first frozen rather than decided.
   */
  describe('the two deleted env-var statements', () => {
    const DELETED = ['projectEnvVars', 'environmentEnvVars'];

    it('is declared in no statement, and granted by no static role', () => {
      const granted = (role: { statements: object }) =>
        DELETED.filter((resource) => resource in role.statements);

      expect(DELETED.filter((resource) => resource in statements)).toEqual([]);
      expect(granted(ownerRole)).toEqual([]);
      expect(granted(adminRole)).toEqual([]);
      expect(granted(memberRole)).toEqual([]);
    });

    /**
     * The escape hatch to check rather than rely on, checked. A
     * stored `organization_role` is a plain JSON column: `resolveRole` merges
     * the rows sharing a name and hands the result to `ac.newRole` with no
     * validation against `statements`, so rows written while these two keys
     * existed still carry them. better-auth's `authorize` iterates the
     * **requested** resources and looks each one up in the role's own grants —
     * a granted key nothing ever requests is never read — so such a row keeps
     * authorizing exactly what it did before, and no migration is needed.
     *
     * **The catalogue is not consulted at runtime at all**, which is the part
     * worth writing down because it is the opposite of how the types read.
     * `createAccessControl(statements)` uses its argument for the *types* of
     * `newRole`, and `role.authorize` resolves a request against the role's own
     * grant map and nothing else. Drafted here as "asking for the deleted
     * resource is refused", and this test said otherwise: a stored role that
     * still grants `projectEnvVars` would authorize a request for it, because
     * better-auth's `unknownResource` branch is a miss in the *role's* grants,
     * not in `statements`. Nothing in `src` asks — that is the whole finding
     * — so the grant is unreachable rather than refused, and the assertion
     * below is the one that means something: the same stored JSON with and
     * without the dead keys answers every request this vocabulary can express
     * identically.
     */
    it('changes no answer a stored role still carrying it gives', () => {
      const stored: Record<string, string[]> = {
        project: ['update'],
        environment: ['read', 'update'],
        projectEnvVars: ['read', 'write'],
        environmentEnvVars: ['read', 'write'],
      };
      const cleaned = Object.fromEntries(
        Object.entries(stored).filter(
          ([resource]) => !DELETED.includes(resource),
        ),
      );
      const restored = ac.newRole(stored);
      const migrated = ac.newRole(cleaned);

      expect(restored.authorize({ project: ['update'] }).success).toBe(true);
      expect(restored.authorize({ project: ['delete'] }).success).toBe(false);

      // Every request the statements can express, both ways round.
      const disagreements = Object.entries(statements)
        .flatMap(([resource, actions]) =>
          actions.map((action) => ({ [resource]: [action] }) as Permissions),
        )
        .filter(
          (request) =>
            restored.authorize(request).success !==
            migrated.authorize(request).success,
        );

      expect(disagreements).toEqual([]);
    });
  });

  /**
   * The env-var deletion finished rather than repeated. `api`, `envVars` and
   * `logs` were declared in `statements`, granted by the static roles, and
   * consulted **nowhere in `src`** — no `@RequirePermission`, no
   * `checkPermission`, and no dynamically assembled key either:
   * `composedCreateStatements` is the one producer of a statement object no
   * guard spells out, and it yields `service`, `domain` and `volume`. The first
   * deletion found all three while enumerating what consults each statement,
   * put them in the sweep's baseline, and left the decision open.
   *
   * The decision is the same one for all three, and the real gate differs per
   * statement, which is why the issue asked for them one at a time:
   *
   * - **`api`** looked like it gated `POST`/`GET`/`DELETE /users/me/api-keys`.
   *   Those are personal: no decorator, the caller's own headers handed to
   *   better-auth, authorized by the session on the caller's own user row.
   *   There is no organization-level question for a statement to answer, and
   *   `api-keys-card.tsx` had already had to say on screen why — an api-key
   *   session carries no `activeOrganizationId`, so a key acts as the whole
   *   person in whichever Organization is their default.
   * - **`envVars`** is the env-var statements' case exactly, and one turn
   *   worse. A Service's own `env` is written by the eight `PATCH
   *   /{engine}/:id/environment` twins, which are behind `service: ['update']`
   *   — and the argument for granting the base member that action *cited*
   *   `envVars: ['read', 'write']` as proof the role was already not read-only
   *   on a Service. Dead and circular at once.
   * - **`logs`** is the one that wanted a decision rather than a deletion,
   *   because a finer grain over log access is imaginable and this is the
   *   statement it would use. Deleted, on ADR-0007 and ADR-0008 rather than on
   *   tidiness: a deployment log is addressed by `deploymentId` and authorized
   *   through `checkServiceAccess` (ADR-0007) with `deployment: ['read']` on
   *   its HTTP twin, and a container log is authorized against the Service that
   *   owns the container, or by `docker: ['read']` where it owns none
   *   (ADR-0008). Requiring this statement *as well* is the shape ADR-0008's
   *   first consequence rejects by name, one column over: a licensed custom
   *   role entitled to a Service and not granted `logs` would lose that
   *   Service's own logs. Deciding how a statement-shaped gate composes with an
   *   id-addressed socket and the managed-container rule is an amendment to two
   *   ADRs, not a line in `statements`.
   */
  describe('the three deleted statements', () => {
    const DELETED = ['api', 'envVars', 'logs'];

    it('is declared in no statement, and granted by no static role', () => {
      const granted = (role: { statements: object }) =>
        DELETED.filter((resource) => resource in role.statements);

      expect(DELETED.filter((resource) => resource in statements)).toEqual([]);
      expect(granted(ownerRole)).toEqual([]);
      expect(granted(adminRole)).toEqual([]);
      expect(granted(memberRole)).toEqual([]);
    });

    /**
     * No migration for a stored role still carrying any of the three, and the
     * reason was **re-verified against the installed better-auth 1.6.33**
     * rather than carried over from the first deletion, because that is what
     * was asked for. Read out of
     * `node_modules/better-auth/dist/plugins/access/access.mjs`:
     * `createAccessControl(s)` returns `{ newRole: (g) => role(g), statements:
     * s }` — its argument is kept only as its own `.statements` and is never
     * consulted by a decision — and `role.authorize` iterates
     * `Object.entries(request)`, looking each **requested** resource up in the
     * role's own grant map. A granted key nothing ever requests is never read.
     *
     * The corollary first recorded and this re-check confirms: asking for a
     * deleted resource is *not* refused by the catalogue. `unknownResource` is a
     * miss in the **role's** grants, so a stored role granting `logs` would
     * authorize a request for `logs` — nothing in `src` asks, which is the
     * whole finding, so the grant is unreachable rather than refused. The
     * assertion below is the one that means something: the same stored JSON
     * with and without the three answers every request this vocabulary can
     * express identically.
     */
    it('changes no answer a stored role still carrying it gives', () => {
      const stored: Record<string, string[]> = {
        service: ['read', 'update'],
        deployment: ['read', 'create'],
        api: ['read'],
        envVars: ['read', 'write'],
        logs: ['read'],
      };
      const cleaned = Object.fromEntries(
        Object.entries(stored).filter(
          ([resource]) => !DELETED.includes(resource),
        ),
      );
      const restored = ac.newRole(stored);
      const migrated = ac.newRole(cleaned);

      expect(restored.authorize({ service: ['update'] }).success).toBe(true);
      expect(restored.authorize({ service: ['delete'] }).success).toBe(false);

      // Unreachable, not refused — the catalogue is not what `authorize`
      // reads. The cast is the finding rather than a workaround: `Permissions`
      // is derived from `statements`, so after the deletion no call site in
      // `src` can even name `logs`, while the role's stored grant map still
      // answers `true` for it. That gap is precisely why nothing has to be
      // migrated, and why the sweep below is the guard rather than the types.
      const retired = { logs: ['read'] } as unknown as Permissions;
      expect(restored.authorize(retired).success).toBe(true);
      expect(migrated.authorize(retired).success).toBe(false);

      // Every request the statements can express, both ways round.
      const disagreements = Object.entries(statements)
        .flatMap(([resource, actions]) =>
          actions.map((action) => ({ [resource]: [action] }) as Permissions),
        )
        .filter(
          (request) =>
            restored.authorize(request).success !==
            migrated.authorize(request).success,
        );

      expect(disagreements).toEqual([]);
    });
  });

  /**
   * The general shape, so none of the five deleted statements can come back
   * under another name and no sixth can arrive quietly. Every declared
   * statement has to be named by a real gate in `backend/src`: a
   * `@RequirePermission('resource', …)` on a route, or a
   * `checkPermission(ctx, { resource: […] })` in a service — which is
   * `checkProjectAccess`, `checkServiceAccess` and `checkEnvironmentAccess`
   * too, since each of those is a wrapper around one such call.
   *
   * `PermissionsGuard`'s own `checkPermission` takes the decorator's metadata
   * rather than a literal, so it names no resource and needs none: the
   * decorator it reads is already counted.
   *
   * **What the baseline is for, and it is not an amnesty.** It now holds four
   * entries and all four are better-auth's organization plugin defaults, which
   * the plugin enforces itself — `statements` declares them so a custom role
   * can be *refused* them (`validatePermissions`'s `internalResources`), not so
   * a Cloudgate route can ask for them. Three Cloudgate statements were once
   * frozen here alongside them because the first deletion covered only its own
   * two; the second took that decision and the three are gone, so **no
   * Cloudgate statement is exempt from this sweep any more.** The cap below
   * came down from seven to four with them, which is what keeps the exemption
   * list from being where the next dead statement is written down instead of
   * deleted.
   *
   * Moved out of the env-var block, where it was nested, once it was guarding two
   * deletions rather than one.
   */
  describe('the sweep that stops another dead statement arriving', () => {
    const UNCONSULTED: readonly string[] = [
      // better-auth's, enforced by the organization plugin. Nothing else is
      // exempt: `api`, `envVars` and `logs` sat here until the statements
      // themselves were deleted.
      'organization',
      'invitation',
      'team',
      'ac',
    ];

    it('leaves no declared statement that no gate in src consults', () => {
      const consulted = resourcesConsultedInSrc();

      expect(
        Object.keys(statements).filter(
          (resource) =>
            !consulted.has(resource) && !UNCONSULTED.includes(resource),
        ),
      ).toEqual([]);
    });

    /**
     * The load-bearing half, borrowed from
     * `test/coding-standards/describe-names.spec.ts`: without it the
     * assertion above is satisfied by writing the next dead statement down.
     */
    it('holds the unconsulted list at the size it was frozen at, or smaller', () => {
      expect(UNCONSULTED.length).toBeLessThanOrEqual(4);
    });

    /**
     * And the other way such a list rots: an entry whose statement was
     * deleted, or which something now consults, stays behind as a standing
     * exemption for that name — so re-declaring it would pass.
     */
    it('carries no entry for a statement that is gone or has since been consulted', () => {
      const consulted = resourcesConsultedInSrc();

      expect(
        UNCONSULTED.filter(
          (resource) => !(resource in statements) || consulted.has(resource),
        ),
      ).toEqual([]);
    });

    /**
     * **The third way the list rots, and the internal-name drop is what made it
     * load-bearing.** `PermissionService.toDeclaredGrants` now drops a stored
     * grant of one of these four from the map it hands `ac.newRole`, and the
     * only thing making that drop inert is the assertion above: nothing asks.
     * So the exemption list and the set the resolver drops have to be the same
     * four names, and `UNCONSULTED` stays hand-written (§1.7) rather than
     * becoming a second reference to `internalResources` — a shared constant
     * would agree with itself while a name silently joined or left the drop.
     */
    it('exempts exactly the resources the resolver drops from a stored role', () => {
      expect([...internalResources]).toEqual([...UNCONSULTED]);
    });
  });
});
