import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { PatchRepoService } from '../../src/patch/patch-repo.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import type { ServersService } from '../../src/servers/servers.service';

/**
 * Which question `PatchRepoService.cleanRepos` asks, in which order, and
 * whether the `rm -rf` was reached on the way to a refusal (ADR-0013).
 *
 * The wire half — an owner of a second Organization refused
 * `POST /patches/repo/clean` — is in `patch-tenancy.e2e-spec.ts`, the only
 * place a second *account* exists. What cannot be seen from there is the thing
 * that makes this a defect rather than a status code: the command globs
 * `{patchReposDirectoryOn(…)}/*`, so a refusal arriving *after* the dispatch
 * would read as a 403 to the caller and have deleted every other organization's
 * clones anyway. So the exec seam is recorded here and asserted to be
 * untouched, and the boundary is stubbed rather than reached — it is the
 * collaborator whose *answer* selects the branch, on
 * `test/environments/environment-tenancy.spec.ts`'s reasoning, and the four
 * collaborators this path must never touch say so instead of answering.
 *
 * `checkInstanceAuthority` itself — that the authority is the *instance*
 * organization's owners and admins, found as the earliest owner `member` row —
 * belongs to `PermissionService` and is pinned in `test/rbac/`; asserting it
 * again through this service would only be asserting the stub.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-a' },
};

/**
 * The command that globs the patch-repos tree, **on the machine it is sent to**.
 * The platform host's tree is under this process's
 * `CLOUDGATE_DIRECTORY` and a Server's under the `/etc/cloudgate` its setup
 * script laid out, so the root is asked of the machine rather than spelled —
 * with the variable unset the two are one literal, which is how a single
 * constant here served both branches and was green for the platform host by
 * coincidence alone. The root comes from `cloudgateDirectoryOn` rather than
 * the `patchReposDirectoryOn` under test; the tail is written out.
 */
const cleanCommandOn = (serverId: string | null) =>
  `rm -rf "${cloudgateDirectoryOn(serverId)}/patch-repos"/* 2>/dev/null || true`;

/** A Server in the caller's own organization, as `findOne` resolves it. */
const OWNED_SERVER = 'server-a';

/** `PermissionService.checkInstanceAuthority`'s sentence, verbatim. */
const INSTANCE_REFUSAL =
  'Only an owner or admin of the instance organization can configure the platform host';

/**
 * A collaborator this path must never touch, which says so instead of
 * answering — `environment-tenancy.spec.ts`'s helper, same purpose.
 */
const unreached = (name: string): never =>
  new Proxy(
    {},
    {
      get: () => {
        throw new Error(`${name} was reached by cleanRepos`);
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
  service: PatchRepoService;
  /** Every command that reached the platform host, in order. */
  local: string[];
  /** Every `(serverId, command)` pair that reached a Server, in order. */
  remote: [string, string][];
  /** Every caller the instance-authority boundary was consulted about. */
  instanceChecks: string[];
  /** Every serverId handed to the organization-scoped Server lookup. */
  lookups: string[];
}

interface HarnessOptions {
  /** The caller's role in their *own* organization. */
  role?: string;
  /** The instance-authority half — what `checkInstanceAuthority` answers. */
  instanceAuthority?: () => Promise<void>;
  /** Server ids `ServersService.findOne` resolves; anything else is a 404. */
  ownedServers?: string[];
}

function harness(options: HarnessOptions = {}): Harness {
  const {
    role = 'owner',
    instanceAuthority = () => Promise.resolve(),
    ownedServers = [OWNED_SERVER],
  } = options;

  const local: string[] = [];
  const remote: [string, string][] = [];
  const instanceChecks: string[] = [];
  const lookups: string[] = [];

  const remoteExec = {
    execAsync: (command: string) => {
      local.push(command);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    },
    execAsyncRemote: (serverId: string, command: string) => {
      remote.push([serverId, command]);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    },
  } as unknown as RemoteExecService;

  const permissions = {
    findMember: () => Promise.resolve({ role }),
    checkInstanceAuthority: (called: PermissionCtx) => {
      instanceChecks.push(called.user.id);
      return instanceAuthority();
    },
  } as unknown as PermissionService;

  const servers = {
    findOne: (_ctx: PermissionCtx, serverId: string) => {
      lookups.push(serverId);
      if (!ownedServers.includes(serverId)) {
        // `ServersService.findOne`'s own refusal: a Server in another
        // organization is byte-identical to an id naming nothing (ADR-0008).
        return Promise.reject(new NotFoundException('Server not found'));
      }
      return Promise.resolve({ serverId });
    },
  } as unknown as ServersService;

  const service = new PatchRepoService(
    unreached('the database'),
    permissions,
    remoteExec,
    unreached('the source-clone service'),
    unreached('the applications service'),
    unreached('the compose service'),
    servers,
  );

  return { service, local, remote, instanceChecks, lookups };
}

describe('PatchRepoService.cleanRepos', () => {
  it('refuses the platform host to an owner who does not administer the instance, before the rm -rf', async () => {
    const state = harness({
      instanceAuthority: () =>
        Promise.reject(new ForbiddenException(INSTANCE_REFUSAL)),
    });

    expect(await refusalOf(state.service.cleanRepos(ctx, {}))).toEqual({
      status: 403,
      message: INSTANCE_REFUSAL,
    });

    // Nothing was deleted on the way to being refused — the whole point, since
    // the command globs the tree rather than this organization's subtree.
    expect(state.local).toEqual([]);
    expect(state.remote).toEqual([]);
  });

  it('reads an explicit null serverId as the platform host, the value the API answers with', async () => {
    const state = harness({
      instanceAuthority: () =>
        Promise.reject(new ForbiddenException(INSTANCE_REFUSAL)),
    });

    // `.nullish()`, so `null` and an absent key are one request and must
    // not be two different answers.
    expect(
      await refusalOf(state.service.cleanRepos(ctx, { serverId: null })),
    ).toEqual({ status: 403, message: INSTANCE_REFUSAL });
    expect(state.local).toEqual([]);
  });

  it('wipes the tree for a caller who does administer the instance', async () => {
    const state = harness();

    await expect(state.service.cleanRepos(ctx, {})).resolves.toBe(true);

    expect(state.instanceChecks).toEqual(['user-1']);
    expect(state.local).toEqual([cleanCommandOn(null)]);
  });

  it('asks the instance nothing for a Server the caller organization owns', async () => {
    const state = harness();

    await expect(
      state.service.cleanRepos(ctx, { serverId: OWNED_SERVER }),
    ).resolves.toBe(true);

    // ADR-0013's second consequence: an organization's owner administers its
    // own fleet, so the named-Server branch is untouched by the host-authority fix.
    expect(state.instanceChecks).toEqual([]);
    expect(state.lookups).toEqual([OWNED_SERVER]);
    expect(state.remote).toEqual([
      [OWNED_SERVER, cleanCommandOn(OWNED_SERVER)],
    ]);
    expect(state.local).toEqual([]);
  });

  it('refuses a Server outside the caller organization without falling through to the host', async () => {
    const state = harness();

    expect(
      await refusalOf(state.service.cleanRepos(ctx, { serverId: 'server-b' })),
    ).toEqual({ status: 404, message: 'Server not found' });

    expect(state.instanceChecks).toEqual([]);
    expect(state.local).toEqual([]);
    expect(state.remote).toEqual([]);
  });

  // A licensed custom role's name is not `owner` or `admin` either, so the
  // second case is the role an operator actually creates rather than a
  // variation on the first.
  it.each(['member', 'deploy-engineer'])(
    'refuses a %s before it asks who administers the instance',
    async (role) => {
      const state = harness({ role });

      expect(await refusalOf(state.service.cleanRepos(ctx, {}))).toEqual({
        status: 403,
        message: 'Only owners and admins can clean patch repos',
      });

      // The narrower question first, so a caller refused for their own role
      // learns nothing about whether this instance has an owner at all.
      expect(state.instanceChecks).toEqual([]);
      expect(state.local).toEqual([]);
    },
  );
});

/**
 * **This is deliberately an enumeration**, on `gateway-leases.e2e-spec.ts`'s
 * reasoning: a type cannot express "and this one asks who administers the
 * instance", so nothing in the compiler notices a sixth method here that
 * reaches the platform host on an organization role — which is the defect the
 * host-authority fix filed, on the one method of the four public ones that takes
 * a `serverId` from the caller rather than from an access-checked row.
 *
 * The keys are asserted against `PatchRepoService.prototype`, so a new method
 * fails here by name until whoever adds it writes down the boundary it takes.
 * It is a module-scoped guard and not the tree-wide one the ticket asked for: a write
 * to the platform host is the *default* in this codebase (a Service with no
 * Server runs there), so "reaches the host" does not discriminate, and the
 * enumeration that would have to carry the semantics is the thing ADR-0013
 * already showed goes stale.
 */
const BOUNDARIES: Readonly<Record<string, string>> = {
  // The platform host, scoped to nothing narrower than the whole tree:
  // PermissionService.checkInstanceAuthority on top of the organization's own
  // owner-or-admin check.
  cleanRepos: 'checkInstanceAuthority, plus the organization owner/admin check',

  // The rest are addressed by a Service the caller named, so the host each one
  // reaches is derived from an access-checked row rather than supplied.
  ensureRepo: "checkAccess(id, type, 'update'), then the row's serverId",
  readRepoDirectory: "checkAccess(id, type, 'read'), then the row's serverId",
  readRepoFile: "checkAccess(id, type, 'read'), then the row's serverId",

  // Private helpers, reached only from the four above.
  catRepoFile: 'private: called after checkAccess resolved the path',
  findEntity: 'private: no authority of its own, no side effect',
  findPatchByFilePath: 'private: no authority of its own, no side effect',
  checkAccess: 'private: the organization-scoped parent lookup itself',
  exec: 'private: the dispatch, authorized by its callers',
  constructor: 'not a method',
};

describe('PatchRepoService', () => {
  it('gives every method that can reach the platform host a named boundary', () => {
    expect(
      Object.getOwnPropertyNames(PatchRepoService.prototype).sort(),
    ).toEqual(Object.keys(BOUNDARIES).sort());
  });
});
