import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { server } from '../../src/db/schema';
import type { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';

/**
 * The order and the fail-closed shape of `EnvironmentsService.create`'s parent
 * lookup, asserted where the whole branch table is reachable.
 *
 * The refusal *pair* is a wire property and lives in
 * `environment-tenancy.e2e-spec.ts`; what cannot be seen from there is which
 * question was asked, in which order, and whether the insert was reached on the
 * way to a refusal. A cross-tenant write that answered 404 and committed the
 * row anyway would satisfy every assertion an HTTP suite can make.
 *
 * Two things are pinned here that a later reader would otherwise have to infer
 * from a docblock:
 *
 * - **The Project is asked for at `'read'`.** `checkProjectAccess`'s read
 *   branch consults no statement — there is no `project: ['read']` — so it adds
 *   no action requirement on top of the `environment: ['create']` the route
 *   already carries. An earlier fix scoped `project: ['update']` to the Project's own
 *   row, and creating an Environment is not a write to that row, so anything
 *   above `'read'` here would refuse a role deliberately granted the create.
 * - **Entitlement runs before the select.** That is `findOwned`'s and
 *   `ProjectsService.findOne`'s order, and it is what keeps the two refusals
 *   indistinguishable for a restricted role: a member reaches the row-level
 *   403 for a foreign Project id and for an id naming nothing alike, without
 *   either one resolving.
 *
 * The database is faked and `PermissionService` stubbed because they are the two
 * collaborators whose *answers* select the branch, and the unused three say so
 * rather than answering, so "the insert was not reached" is asserted rather
 * than claimed.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-a' },
};

/** The Project row the organization-scoped select projects. */
const OWNED_PROJECT = { projectId: 'proj-a' };

/** The created row, as `.returning()` answers it. */
const CREATED = {
  environmentId: 'env-1',
  name: 'production',
  projectId: 'proj-a',
};

/**
 * A collaborator this path must never touch, which says so instead of
 * answering — `preview-entitlement.spec.ts`'s helper, same purpose.
 */
const unreached = (name: string): never =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error(`${name} was reached by a create`);
      },
    },
  ) as unknown as never;

interface Refusal {
  status: number;
  message: string;
}

/** What a caller reads off a refusal: the two things the filter puts on the wire. */
async function refusalOf(pending: Promise<unknown>): Promise<Refusal> {
  try {
    await pending;
  } catch (error) {
    if (
      error instanceof NotFoundException ||
      error instanceof ForbiddenException
    ) {
      return { status: error.getStatus(), message: error.message };
    }
    throw error;
  }
  throw new Error('the call was expected to be refused and was not');
}

interface Harness {
  service: EnvironmentsService;
  /** Every `checkProjectAccess` call, as (action, id) pairs. */
  projectAccess: [string, string | undefined][];
  /** Every organization-scoped Project lookup that ran. */
  selects: number;
  /** Every row handed to `insert(environment).values(...)`. */
  inserted: unknown[];
  /** Every environment id granted to the creator afterwards. */
  granted: string[];
}

interface HarnessOptions {
  /** What the Project lookup answers. Empty is "no such id in this org". */
  rows?: { projectId: string }[];
  /** The entitlement half — the branch that reads `accessedProjects`. */
  entitlement?: () => Promise<void>;
}

function harness(options: HarnessOptions = {}): Harness {
  const { rows = [OWNED_PROJECT], entitlement = () => Promise.resolve() } =
    options;

  const state: Harness = {
    service: unreached('the service under test'),
    projectAccess: [],
    selects: 0,
    inserted: [],
    granted: [],
  };

  // The Deploy target's "has this organization a deploy Server" question
  // is the one other select a create runs; it answers none here, so the
  // platform host is taken without asking.
  const db = {
    select: () => {
      state.selects += 1;
      let answer: unknown[] = rows;
      const selectChain = {
        from: (table: unknown) => {
          if (table === server) answer = [];
          return selectChain;
        },
        where: () => selectChain,
        limit: () => Promise.resolve(answer),
      };
      return selectChain;
    },
    insert: () => ({
      values: (row: unknown) => {
        state.inserted.push(row);
        return { returning: () => Promise.resolve([CREATED]) };
      },
    }),
  } as unknown as DrizzleDB;

  const permissions = {
    checkProjectAccess: (
      _ctx: PermissionCtx,
      action: string,
      projectId?: string,
    ): Promise<void> => {
      state.projectAccess.push([action, projectId]);
      return entitlement();
    },
    addNewEnvironment: (
      _ctx: PermissionCtx,
      environmentId: string,
    ): Promise<void> => {
      state.granted.push(environmentId);
      return Promise.resolve();
    },
  } as unknown as PermissionService;

  state.service = new EnvironmentsService(
    db,
    permissions,
    unreached('RemoteExecService'),
    unreached('TraefikWriterService'),
    unreached('EnvironmentHealthService'),
    unreached('CloudAccountsService'),
    unreached('ModuleRef'),
    unreached('BucketDeletes'),
    // A Self-hosted instance: the platform host is a Deploy target.
    { refusePlatformHost: () => undefined } as unknown as InstanceMode,
    unreached('BillingService'),
  );
  return state;
}

const createIn = (service: EnvironmentsService, projectId: string) =>
  service.create(ctx, { name: 'production', projectId });

describe('EnvironmentsService.create', () => {
  it('refuses a Project the organization-scoped lookup does not find', async () => {
    const found = harness({ rows: [] });

    const refusal = await refusalOf(createIn(found.service, 'proj-b'));

    expect(refusal).toEqual({ status: 404, message: 'Project not found' });
    // Nothing was written on the way to being refused, and nobody was granted
    // access to a row that does not exist — the pre-fix shape was a 201 and a
    // committed row in the other organization's Project.
    expect(found.inserted).toEqual([]);
    expect(found.granted).toEqual([]);
  });

  it('asks for the parent Project at read level, and asks about the id from the body', async () => {
    const found = harness({ rows: [] });

    await refusalOf(createIn(found.service, 'proj-b'));

    expect(found.projectAccess).toEqual([['read', 'proj-b']]);
  });

  it('refuses a caller the entitlement branch rejects, before the Project resolves', async () => {
    const found = harness({
      entitlement: () =>
        Promise.reject(
          new ForbiddenException("You don't have access to this project"),
        ),
    });

    const refusal = await refusalOf(createIn(found.service, 'proj-a'));

    expect(refusal).toEqual({
      status: 403,
      message: "You don't have access to this project",
    });
    // The lookup never ran, so a restricted role learns nothing about whether
    // the id resolves — the same order `findOwned` runs its two halves in.
    expect(found.selects).toBe(0);
    expect(found.inserted).toEqual([]);
  });

  it('creates the Environment and grants its creator access when the Project resolves', async () => {
    const found = harness();

    await expect(createIn(found.service, 'proj-a')).resolves.toEqual({
      ...CREATED,
      warnings: [],
    });

    expect(found.selects).toBe(2);
    expect(found.inserted).toEqual([
      {
        name: 'production',
        projectId: 'proj-a',
        deployTarget: { kind: 'platform-host' },
      },
    ]);
    expect(found.granted).toEqual(['env-1']);
  });
});
