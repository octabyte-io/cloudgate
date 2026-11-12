import {
  ac,
  adminRole,
  memberRole,
  ownerRole,
  statements,
} from '../../src/rbac/access-control';
import { toDeclaredGrants } from '../../src/rbac/permission.service';
import type { Permissions } from '../../src/rbac/permission.service';

/**
 * What `PermissionService.resolveRole` hands better-auth, once a stored
 * `organization_role` row can carry a grant the vocabulary no longer declares.
 *
 * The property under test is **not** that the drop refuses something: it is
 * that the drop refuses *nothing*. Two earlier changes each deleted statements
 * with no migration, on the strength of a granted key nothing requests never
 * being read — so if this filter changed one answer a stored role gives, it
 * would be the migration those two issues declined to write, arriving by the
 * back door. Hence the differential sweep below rather than a hand-picked
 * assertion pair.
 *
 * `test/rbac/access-control.spec.ts` pins the same property of `ac.newRole`
 * itself; this pins the filter in front of it.
 */

/**
 * The five retired statements, written out here rather than
 * derived from anything under test (§1.7). Every one of them was declared in
 * `statements` and granted by all three static roles at the time it was
 * deleted, so a row written before that deletion still carries it — which is
 * what makes this the real case rather than a hypothetical one.
 */
const RETIRED = [
  'projectEnvVars',
  'environmentEnvVars',
  'api',
  'envVars',
  'logs',
];

/**
 * The four resources better-auth's organization plugin owns, written out here
 * rather than imported from anything under test (§1.7). Unlike {@link RETIRED}
 * every one of them **is** a declared statement, which is what makes them a
 * second kind of inert grant rather than another instance of the undeclared
 * one.
 */
const INTERNAL = ['organization', 'invitation', 'team', 'ac'];

/** Every request this vocabulary can express, one action at a time. */
const EVERY_REQUEST: Permissions[] = Object.entries(statements).flatMap(
  ([resource, actions]) =>
    actions.map((action) => ({ [resource]: [action] }) as Permissions),
);

/**
 * The subset of {@link EVERY_REQUEST} a gate in `backend/src` can actually
 * make, which is every request naming a resource outside {@link INTERNAL}.
 *
 * **This split is the whole difference between the undeclared-name drop and the
 * internal-name drop, and it is why the sweep below narrowed.** The first
 * dropped names `statements` does not declare, so `EVERY_REQUEST` could not
 * name one and the drop provably changed no answer *to any request at all*. The
 * second drops four names it does. So the drop does change what `ac.newRole`
 * answers for a request naming one — asserted below rather than glossed — and
 * what makes it inert is the other half: nothing ever makes such a request.
 * That half is established once, by `test/rbac/access-control.spec.ts`'
 * `UNCONSULTED` sweep over every `@RequirePermission` and `checkPermission`
 * call site in `src`, and is cited here rather than duplicated.
 */
const REACHABLE_REQUEST: Permissions[] = EVERY_REQUEST.filter(
  (request) => !INTERNAL.includes(Object.keys(request)[0]),
);

/** A grant map without the four, for the expectations that need one. */
function withoutInternal(
  grants: Readonly<Record<string, readonly string[]>>,
): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(grants).filter(([resource]) => !INTERNAL.includes(resource)),
  );
}

describe('toDeclaredGrants', () => {
  it('confirms every retired name is undeclared, so the cases below are the real ones', () => {
    expect(RETIRED.filter((resource) => resource in statements)).toEqual([]);
  });

  it('drops a stored grant of a retired statement and names it', () => {
    const stored = {
      service: ['read', 'update'],
      auditLog: ['read'],
      logs: ['read'],
    };

    expect(toDeclaredGrants(stored)).toEqual({
      grants: { service: ['read', 'update'], auditLog: ['read'] },
      dropped: ['logs'],
      internal: [],
    });
  });

  it('drops an action the resource does not declare and keeps the resource', () => {
    // `write` is a `docker` action and not a `service` one, so this is the
    // misspelling shape rather than the retirement shape. The key survives with
    // its declared actions: dropping the whole resource would move better-auth
    // from its `unauthorized to access resource` branch to its
    // `not allowed to access resource` one and change the refusal's wording for
    // no reason.
    expect(toDeclaredGrants({ service: ['read', 'write'] })).toEqual({
      grants: { service: ['read'] },
      dropped: ['service:write'],
      internal: [],
    });

    expect(toDeclaredGrants({ auditLog: ['write'] })).toEqual({
      grants: { auditLog: [] },
      dropped: ['auditLog:write'],
      internal: [],
    });
  });

  it('leaves each of the three static roles as access-control declares it, but for the four a custom role cannot be delegated', () => {
    // The "provably inert for every legitimate role" direction, against the
    // three grant maps that are not this module's to define: if the filter
    // touched a declared grant, one of these would come back changed.
    //
    // The four better-auth resources are the one exception and asserting them
    // *by name* is stronger than the identity this used to claim: it pins that
    // they are the only difference, and that a static role's own map is not
    // this function's subject — `resolveRole` returns each of the three
    // built-ins before any of them reaches it.
    for (const [name, role] of [
      ['owner', ownerRole],
      ['admin', adminRole],
      ['member', memberRole],
    ] as const) {
      expect({ name, ...toDeclaredGrants(role.statements) }).toEqual({
        name,
        grants: withoutInternal(role.statements),
        dropped: [],
        internal: INTERNAL,
      });
    }
  });

  it('leaves every single-statement grant a custom role may hold untouched', () => {
    for (const [resource, actions] of Object.entries(statements)) {
      if (INTERNAL.includes(resource)) continue;
      const grants = { [resource]: [...actions] };

      expect(toDeclaredGrants(grants)).toEqual({
        grants,
        dropped: [],
        internal: [],
      });
    }
  });

  it('changes no answer a stored role carrying all five retired names gives', () => {
    // The whole point of the change: the same stored JSON, resolved with and
    // without the filter, authorizes identically. A disagreement here is the
    // migration the two statement deletions deliberately did not write.
    //
    // Swept over `REACHABLE_REQUEST` rather than `EVERY_REQUEST` since the
    // internal-name drop, which added a second bucket whose four names the
    // vocabulary *does* declare; that module note carries the reason and the
    // internal describe below asserts the difference the narrowing hides here.
    const stored: Record<string, string[]> = {
      ...Object.fromEntries(
        Object.entries(statements).map(([resource, actions]) => [
          resource,
          [...actions],
        ]),
      ),
      ...Object.fromEntries(RETIRED.map((resource) => [resource, ['read']])),
      service: ['read', 'update', 'writ'],
    };

    const asStored = ac.newRole(stored);
    const asDropped = ac.newRole(toDeclaredGrants(stored).grants);

    const disagreements = REACHABLE_REQUEST.filter(
      (request) =>
        asStored.authorize(request).success !==
        asDropped.authorize(request).success,
    );

    expect(disagreements).toEqual([]);
    // And the sweep is worth something only if it is answering `true`
    // somewhere: a role granted everything is granted everything.
    expect(asDropped.authorize({ service: ['update'] }).success).toBe(true);
  });

  it('reports the same drops for a role granting nothing declared at all', () => {
    expect(toDeclaredGrants({ logs: ['read'], envVars: ['read'] })).toEqual({
      grants: {},
      dropped: ['logs', 'envVars'],
      internal: [],
    });
  });

  /**
   * The second bucket.
   *
   * `organization`, `invitation`, `team` and `ac` are declared statements, so
   * the undeclared-name drop kept them — its subject was names the catalogue
   * does not declare. They are inert all the same, and the two halves of why
   * are in different places: no gate in `src` names one
   * (`access-control.spec.ts`' `UNCONSULTED` sweep), and better-auth's own
   * organization plugin — which *does* enforce all four — enforces them against
   * its own `defaultRoles`, never against this grant map. `hasPermission`
   * (`node_modules/better-auth/dist/plugins/organization/has-permission.mjs`,
   * 1.6.33) starts from `input.options.roles || defaultRoles`, and the one
   * branch that would read an `organizationRole` row is behind
   * `options.dynamicAccessControl?.enabled && options.ac` — `createAuth`'s
   * `organization({ … })` passes none of the three. So the plugin never sees a
   * Cloudgate custom role's grants at all.
   *
   * **The two buckets are separate because the remedies are.** An undeclared
   * grant was legal when it was written and re-saving the role clears it. An
   * internal one was never legal: `validatePermissions` has refused all four
   * since the surface landed, on `create` and on `update`, so no row carrying
   * one came through the API — it came from a migration or a hand-run `UPDATE`.
   * Pointing the reader of the undeclared-name line at a retired statement
   * would be the wrong errand for it.
   */
  describe('a grant of a resource better-auth owns', () => {
    it('confirms every internal name is declared, so this is not the undeclared-name drop again', () => {
      expect(INTERNAL.filter((resource) => !(resource in statements))).toEqual(
        [],
      );
    });

    /**
     * The real case rather than a hypothetical one: `team` is the one of the
     * four a stored grant map is likeliest to carry, and `read` is not even a
     * declared `team` action — so this pins the check order too. Reported as
     * the resource `team`, the way `validatePermissions` refuses it, and not as
     * the undeclared action `team:read`.
     */
    it('drops a stored grant of team and names the resource, not the action', () => {
      expect(toDeclaredGrants({ service: ['read'], team: ['read'] })).toEqual({
        grants: { service: ['read'] },
        dropped: [],
        internal: ['team'],
      });
    });

    it('drops each of the four, whether or not the action is declared', () => {
      for (const resource of INTERNAL) {
        expect({
          resource,
          ...toDeclaredGrants({ [resource]: ['read', 'update'] }),
        }).toEqual({
          resource,
          grants: {},
          dropped: [],
          internal: [resource],
        });
      }
    });

    it('keeps the two buckets apart for a role carrying one of each', () => {
      expect(
        toDeclaredGrants({
          service: ['read'],
          logs: ['read'],
          ac: ['read'],
        }),
      ).toEqual({
        grants: { service: ['read'] },
        dropped: ['logs'],
        internal: ['ac'],
      });
    });

    it('changes no answer to a request any gate in src can make', () => {
      // Same differential shape as the undeclared-name sweep one describe up,
      // over a stored map that grants all four outright.
      const stored: Record<string, string[]> = {
        ...Object.fromEntries(
          Object.entries(statements).map(([resource, actions]) => [
            resource,
            [...actions],
          ]),
        ),
      };

      const asStored = ac.newRole(stored);
      const asDropped = ac.newRole(toDeclaredGrants(stored).grants);

      const disagreements = REACHABLE_REQUEST.filter(
        (request) =>
          asStored.authorize(request).success !==
          asDropped.authorize(request).success,
      );

      expect(disagreements).toEqual([]);
      // Worth something only if it is answering `true` somewhere.
      expect(asDropped.authorize({ service: ['update'] }).success).toBe(true);
      expect(REACHABLE_REQUEST.length).toBeGreaterThan(20);
    });

    /**
     * **The honest half, and the reason this drop rests on a sweep rather than
     * on a differential.** Unlike the undeclared-name drop, it is not
     * answer-preserving over every request the vocabulary can express: `ac` is
     * declared, so `role.authorize({ ac: ['read'] })` finds the grant before
     * the drop and does not after. Nothing in the product asks — that is what
     * `access-control.spec.ts` establishes and what the drop is safe on. Saying
     * so here is what stops a later reader taking "provably inert" from the
     * describe above and assuming it covers these four as well.
     */
    it('does change what a request naming one of the four is answered', () => {
      const stored: Record<string, string[]> = {
        ac: ['read'],
        service: ['read'],
      };

      const asStored = ac.newRole(stored);
      const asDropped = ac.newRole(toDeclaredGrants(stored).grants);

      expect(asStored.authorize({ ac: ['read'] }).success).toBe(true);
      expect(asDropped.authorize({ ac: ['read'] }).success).toBe(false);
      // And no request outside the four moved with it.
      expect(asDropped.authorize({ service: ['read'] }).success).toBe(true);
    });
  });
});
