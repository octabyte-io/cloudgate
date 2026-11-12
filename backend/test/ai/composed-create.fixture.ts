import { ForbiddenException } from '@nestjs/common';
import type {
  PermissionCtx,
  Permissions,
  PermissionService,
} from '../../src/rbac/permission.service';

/**
 * The pieces `AiService.deploy`'s pre-flight spec
 * (`test/ai/deploy-preflight.spec.ts`) runs against. The `template.toml`
 * deploy's spec used them too until #1364 removed that deploy.
 *
 * It lives beside that spec rather than in `test/utils` because §1.7 wants a
 * fixture beside the feature that needs it. The rule under test,
 * `composedCreateStatements`, is `src/compose/composed-create-statements.ts`,
 * which a Template's Apply (`PlanApplier.check`) asks too.
 *
 * **Why the collaborators are stubbed at all**, given §1.7's "doubles only at
 * system boundaries". What is under test is an *ordering* property across three
 * services — that no refusal any of them can give is reachable after the first
 * write — and neither the ordering nor the "nothing was created" half is
 * visible from inside any one of them. The stubs are kept honest two ways: they
 * reproduce the real gates literally, and
 * {@link COLLABORATOR_GATES} is asserted against `src` so a gate that moves
 * fails the spec instead of quietly making it vacuous.
 */

export const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

/** A role's own statement table: resource → the actions it holds. */
export type RoleStatements = Record<string, string[]>;

/**
 * The narrowest role that clears both routes' own gates — `ai.e2e-spec.ts`'s
 * `deployer`, verbatim, because that is the one caller that can reach these
 * refusals at all. Owner and admin hold every statement in the product and
 * skip the row-level half of `checkServiceAccess`, which is exactly why the earlier
 * regression and the pre-flight's residue stayed invisible to the static roles.
 */
export const DEPLOYER: RoleStatements = {
  service: ['create', 'read'],
  domain: ['create', 'read'],
  volume: ['create', 'read'],
  environment: ['read'],
};

/** {@link DEPLOYER} with one action taken off one resource. */
export function roleWithout(
  resource: keyof typeof DEPLOYER,
  action: string,
): RoleStatements {
  return {
    ...DEPLOYER,
    [resource]: DEPLOYER[resource].filter((held) => held !== action),
  };
}

/**
 * Everything a deploy did, in the order it did it — so "refused before
 * anything was created" is asserted rather than inferred from a status code.
 */
export interface Journal {
  /** Every `checkPermission` statement, in call order. */
  statements: Permissions[];
  /** Every `checkServiceAccess` call, as an (id, action) pair. */
  serviceAccess: [string, string][];
  /** The app name of every stack `createByTemplate` inserted. */
  created: string[];
  /** Every `addNewService` grant. */
  granted: string[];
  /** Every child row the population loops actually attached, in order. */
  attached: string[];
}

export const journal = (): Journal => ({
  statements: [],
  serviceAccess: [],
  created: [],
  granted: [],
  attached: [],
});

/**
 * `PermissionService`, reproduced rather than doubled: `checkPermission`
 * authorizes the statement against the role's own table, and
 * `checkServiceAccess` is its two documented halves — the role half, which is
 * literally `checkPermission(ctx, { service: [action] })`, and the row-level
 * half over `accessedProjects` / `accessedServices`. The row-level half reads
 * `journal.granted`, because `addNewService` is what writes that column and the
 * ordering of the grant against the loops is half of what is under test.
 *
 * The owner/admin bypass is deliberately absent: this caller is a licensed
 * custom role, the only kind that can reach any of these refusals.
 */
export function permissionsStub(
  state: Journal,
  role: RoleStatements,
  entitledProjects: string[],
): PermissionService {
  const authorize = (statement: Permissions): void => {
    state.statements.push(statement);
    const held = Object.entries(statement).every(([resource, actions]) =>
      (actions as string[]).every((action) => role[resource]?.includes(action)),
    );
    if (!held) throw new ForbiddenException('Permission denied');
  };

  return {
    checkPermission: (_ctx: PermissionCtx, statement: Permissions) => {
      authorize(statement);
      return Promise.resolve();
    },
    checkServiceAccess: (
      _ctx: PermissionCtx,
      serviceId: string,
      action: string = 'read',
    ) => {
      state.serviceAccess.push([serviceId, action]);
      authorize({ service: [action] } as Permissions);
      if (action === 'create') {
        if (!entitledProjects.includes(serviceId)) {
          throw new ForbiddenException("You don't have access to this project");
        }
      } else if (!state.granted.includes(serviceId)) {
        throw new ForbiddenException("You don't have access to this service");
      }
      return Promise.resolve();
    },
    addNewService: (_ctx: PermissionCtx, serviceId: string) => {
      state.granted.push(serviceId);
      return Promise.resolve();
    },
  } as unknown as PermissionService;
}

/**
 * The gates the two collaborator stubs below reproduce, as the lines they are
 * written on in `src`.
 *
 * The anti-vacuity half, and the reason the stubs may model a gate at all: a
 * stub that guessed wrong would let this whole spec pass over a route that no
 * longer refuses anything. Asserted by
 * `composed-create-preflight.spec.ts` against the two source files, which is
 * `test/coding-standards/composed-creates.spec.ts`' technique — resolve one
 * hop, read the gates written literally in the method the caller names.
 */
export const COLLABORATOR_GATES: readonly {
  file: string;
  method: string;
  gates: readonly string[];
}[] = [
  {
    file: 'src/domains/domains.service.ts',
    method: 'create',
    gates: [
      "await this.permissions.checkPermission(ctx, { domain: ['create'] });",
      "await this.permissions.checkServiceAccess(ctx, parent.serviceId, 'read');",
    ],
  },
  {
    file: 'src/mounts/mounts.service.ts',
    method: 'createForNewService',
    gates: [
      "await this.permissions.checkPermission(ctx, { volume: ['create'] });",
      "await this.permissions.checkServiceAccess(ctx, data.serviceId, 'read');",
    ],
  },
];

/**
 * The three collaborators a composed create populates through, each running the
 * gates its real counterpart runs — see {@link COLLABORATOR_GATES} — and
 * recording what it attached.
 *
 * `assertHostsUnclaimed` and `assertRoutesUntaken` answer rather than refuse:
 * the host and route pre-flights are already hoisted on both routes and are
 * not what these cases are about, and a refusal there would hide the one that
 * is.
 */
export function collaborators(state: Journal, permissions: PermissionService) {
  const compose = {
    createByTemplate: (input: { appName: string }) => {
      state.created.push(input.appName);
      return Promise.resolve({ composeId: 'compose-1', ...input });
    },
  } as unknown as never;

  const domains = {
    assertHostsUnclaimed: () => Promise.resolve(),
    assertRoutesUntaken: () => Promise.resolve(),
    create: async (
      caller: PermissionCtx,
      data: { host: string; composeId: string },
    ) => {
      await permissions.checkPermission(caller, { domain: ['create'] });
      await permissions.checkServiceAccess(caller, data.composeId, 'read');
      state.attached.push(`domain ${data.host}`);
      return { domainId: `domain-${state.attached.length}` };
    },
  } as unknown as never;

  const mounts = {
    createForNewService: async (
      caller: PermissionCtx,
      data: { filePath: string; serviceId: string },
    ) => {
      await permissions.checkPermission(caller, { volume: ['create'] });
      await permissions.checkServiceAccess(caller, data.serviceId, 'read');
      state.attached.push(`mount ${data.filePath}`);
      return { mountId: `mount-${state.attached.length}` };
    },
  } as unknown as never;

  return { compose, domains, mounts };
}

/**
 * A collaborator no case here may touch, which says so instead of answering.
 * `never` rather than `{}` so a path that starts using one fails by name
 * instead of reading `undefined` off an empty object.
 */
export const unreached = (name: string): never =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error(`${name} was reached by a refused deploy`);
      },
    },
  ) as unknown as never;

interface Refusal {
  status: number;
  message: string;
}

/** What a caller reads off a refusal: the two things the filter puts on the wire. */
export async function refusalOf(pending: Promise<unknown>): Promise<Refusal> {
  try {
    await pending;
  } catch (error) {
    if (error instanceof ForbiddenException) {
      return { status: error.getStatus(), message: error.message };
    }
    throw error;
  }
  throw new Error('the call was expected to be refused and was not');
}
