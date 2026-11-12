import type { MemberEntitlements } from "@/lib/api/endpoints/organizations";

/**
 * The three `accessed*` columns as the dialog holds them, and the rules that
 * turn them back into a body `PATCH /organizations/members/:id/entitlements`
 * will accept.
 *
 * ## Why this is a module and not `useState` in the dialog
 *
 * Two requirements of that route pull against each other, and reconciling them
 * is the whole of the logic here.
 *
 * 1. **It replaces per column.** An absent key leaves that column untouched and
 *    `[]` clears it, so a client that sends a diff silently revokes everything
 *    it did not mention. `entitlementsBody` therefore always emits all three
 *    keys. Replacement was chosen deliberately: add-one/remove-one is
 *    the shape `PermissionService.grantAccess` has — read the array, write a
 *    computed one — which loses a grant made between the read and the write.
 * 2. **It refuses the whole write on one dead id.** `assertGrantsResolve`
 *    answers `404 Project not found: <id>` if any submitted id no longer
 *    resolves inside the Organization, and `setMemberEntitlements` is
 *    explicitly not transactional, so a `member` row keeps ids for Projects,
 *    Environments and Services that have since been deleted. Sending back "the
 *    whole set you read" would therefore refuse on exactly the rows that most
 *    need editing.
 *
 * So the set is whole *and* filtered: everything the dialog read goes back,
 * minus the ids an inventory has **positively shown** to be gone. The
 * positively matters — an id whose scope has not been read is kept, because
 * absence of evidence is not a deleted Environment, and dropping it would be
 * this dialog committing the silent revocation it exists to avoid.
 *
 * ## The cascade
 *
 * `PermissionService.checkProjectAccess` and `checkEnvironmentAccess` are three
 * independent row-level checks, so a Service grant without its Environment and
 * Project leaves the Member holding a Service they cannot navigate to: the
 * Project read is refused before they ever reach it. Ticking therefore travels
 * **up** and unticking travels **down**, which is what stops the dialog being
 * able to express that state at all.
 */

/** What is ticked, by id. Plain arrays so the whole thing compares by value. */
export interface AccessGrants {
  projects: string[];
  environments: string[];
  services: string[];
}

/**
 * What the dialog has actually managed to read, and how far.
 *
 * The parent maps are the cascade's knowledge and the `*Loaded` sets are its
 * confidence: a parent map is a lookup, but only the loaded set can say "this
 * scope answered, so an id missing from the map is missing from the
 * Organization". They are separate because a fan-out half-fails — one
 * Environment list refusing must not make every id under the others look dead.
 */
export interface AccessInventory {
  /** Every Project in the Organization, or `null` until that read answers. */
  projects: readonly string[] | null;
  /** environmentId → projectId, for every Environment loaded so far. */
  environmentParent: ReadonlyMap<string, string>;
  /** serviceId → environmentId, likewise. */
  serviceParent: ReadonlyMap<string, string>;
  /** Projects whose Environment list came back — a success, not an attempt. */
  projectsLoaded: ReadonlySet<string>;
  /** Environments whose service roster came back. */
  environmentsLoaded: ReadonlySet<string>;
}

/**
 * The member row's own three columns — the dialog's defaults, read once. A
 * person's row or an Agent's: only the three columns are read.
 */
export function seedGrants(member: MemberEntitlements): AccessGrants {
  return {
    projects: [...member.accessedProjects],
    environments: [...member.accessedEnvironments],
    services: [...member.accessedServices],
  };
}

/**
 * Nothing ticked — where an Agent's grant starts. Deliberate, not a
 * default nobody changed: an Agent saved like this reads "Reaches nothing yet".
 */
export function noGrants(): AccessGrants {
  return { projects: [], environments: [], services: [] };
}

export function toggleProject(
  grants: AccessGrants,
  projectId: string,
  on: boolean,
  inventory: AccessInventory,
): AccessGrants {
  if (on) return { ...grants, projects: withId(grants.projects, projectId) };

  const dropped = new Set(
    grants.environments.filter(
      (id) => inventory.environmentParent.get(id) === projectId,
    ),
  );
  return {
    projects: grants.projects.filter((id) => id !== projectId),
    environments: grants.environments.filter((id) => !dropped.has(id)),
    services: grants.services.filter((id) => {
      const parent = inventory.serviceParent.get(id);
      return parent === undefined || !dropped.has(parent);
    }),
  };
}

export function toggleEnvironment(
  grants: AccessGrants,
  environmentId: string,
  on: boolean,
  inventory: AccessInventory,
): AccessGrants {
  if (on) {
    const project = inventory.environmentParent.get(environmentId);
    return {
      ...grants,
      projects:
        project === undefined ? grants.projects : withId(grants.projects, project),
      environments: withId(grants.environments, environmentId),
    };
  }

  return {
    ...grants,
    environments: grants.environments.filter((id) => id !== environmentId),
    services: grants.services.filter(
      (id) => inventory.serviceParent.get(id) !== environmentId,
    ),
  };
}

export function toggleService(
  grants: AccessGrants,
  serviceId: string,
  on: boolean,
  inventory: AccessInventory,
): AccessGrants {
  if (!on) {
    return {
      ...grants,
      services: grants.services.filter((id) => id !== serviceId),
    };
  }

  const environment = inventory.serviceParent.get(serviceId);
  const withService = { ...grants, services: withId(grants.services, serviceId) };
  return environment === undefined
    ? withService
    : toggleEnvironment(withService, environment, true, inventory);
}

/**
 * The held ids an inventory has shown are gone — a Project deleted since the
 * grant was made, or an Environment held without the Project that reaches it.
 *
 * One list covers both cases because the dialog does the same thing with them
 * and the Member is in the same position either way: the grant names something
 * they cannot get to. Saying "no longer exists" of the second would be a lie,
 * so the copy that renders this says both halves.
 *
 * A column is only judged once every scope that could contain its ids has come
 * back. Until then the answer is the empty list, and the id survives into the
 * body untouched.
 */
export function strandedGrants(
  grants: AccessGrants,
  inventory: AccessInventory,
): AccessGrants {
  const known = inventory.projects === null ? null : new Set(inventory.projects);
  const projects =
    known === null ? [] : grants.projects.filter((id) => !known.has(id));

  const live = new Set(projects);
  const environmentsSettled =
    known !== null &&
    grants.projects.every(
      (id) => live.has(id) || inventory.projectsLoaded.has(id),
    );
  const environments = environmentsSettled
    ? grants.environments.filter((id) => !inventory.environmentParent.has(id))
    : [];

  const deadEnvironments = new Set(environments);
  const servicesSettled =
    environmentsSettled &&
    grants.environments.every(
      (id) =>
        deadEnvironments.has(id) || inventory.environmentsLoaded.has(id),
    );
  const services = servicesSettled
    ? grants.services.filter((id) => !inventory.serviceParent.has(id))
    : [];

  return { projects, environments, services };
}

/**
 * The whole set, all three keys, minus what is provably gone.
 *
 * Never a diff, never a partial body, never an absent key — see the header for
 * what each of those would cost.
 */
export function entitlementsBody(
  grants: AccessGrants,
  inventory: AccessInventory,
): MemberEntitlements {
  const stranded = strandedGrants(grants, inventory);
  return {
    accessedProjects: keep(grants.projects, stranded.projects),
    accessedEnvironments: keep(grants.environments, stranded.environments),
    accessedServices: keep(grants.services, stranded.services),
  };
}

/**
 * Whether saving this body would change anything.
 *
 * Order-insensitive: the columns are sets that arrive as arrays, and a
 * re-ordering is not an edit. Only used to keep the button from firing a
 * request that would be a no-op — the write itself is idempotent, so being
 * wrong here would cost a round trip rather than a grant.
 */
export function grantsDiffer(
  body: MemberEntitlements,
  member: MemberEntitlements,
): boolean {
  return (
    !sameSet(body.accessedProjects, member.accessedProjects) ||
    !sameSet(body.accessedEnvironments, member.accessedEnvironments) ||
    !sameSet(body.accessedServices, member.accessedServices)
  );
}

function withId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids : [...ids, id];
}

function keep(ids: string[], drop: string[]): string[] {
  const gone = new Set(drop);
  return [...new Set(ids.filter((id) => !gone.has(id)))];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}
