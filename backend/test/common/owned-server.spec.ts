import { NotFoundException } from '@nestjs/common';
import { checkServerAccess } from '../../src/common/owned-server';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { Server } from '../../src/servers/server.schema';

/**
 * An earlier fix collapsed five copies of the org-scoped Server lookup into one, and the
 * copy that survived is the one with the branch a reader is most likely to read
 * as a bug: an absent `serverId` resolves to `undefined` and does not throw.
 *
 * That branch is the platform host's, and it is load-bearing across the whole
 * HTTP surface — ADR-0008's second consequence records "no server row to check"
 * as the deliberate contract, and ADR-0010 turns on the platform host having no
 * `server` row to find in the first place. "Tightening" it would refuse the
 * local-host branch of every docker-ops, swarm, cluster and settings route at
 * once, and would do it quietly: those routes send no `serverId` at all, so
 * nothing in the request would look wrong.
 *
 * So this suite exists to make that refactor fail here first, next to the two
 * ADRs that explain why it should. The database is a `Proxy` that throws on any
 * use for the absent case, because resolving to `undefined` before a query is
 * the other half of the contract — a caller reaches this with no row to look up.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

/** A database that fails loudly if the absent-id branch tries to query it. */
const unreachableDb = new Proxy(
  {},
  {
    get() {
      throw new Error('an absent serverId must not reach the database');
    },
  },
) as DrizzleDB;

/** The select → from → where → limit chain, answering `rows`. */
function dbAnswering(rows: unknown[]): DrizzleDB {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(rows),
  };
  return chain as unknown as DrizzleDB;
}

describe('checkServerAccess', () => {
  // Every spelling a caller can arrive with. `undefined` is a route that takes
  // no serverId, `null` is a DTO field declared `nullish()`, and `''` is a bare
  // `?serverId=` in a query string — all three mean the platform host.
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['the empty string', ''],
  ])('resolves to undefined for %s, without a query', async (_label, id) => {
    await expect(
      checkServerAccess(unreachableDb, ctx, id),
    ).resolves.toBeUndefined();
  });

  it('throws NotFound for an id the organization-scoped select does not find', async () => {
    await expect(
      checkServerAccess(dbAnswering([]), ctx, 'a-server-in-another-org'),
    ).rejects.toThrow(NotFoundException);
  });

  // Widened from `{ serverId, ipAddress }` when the five lookups became one:
  // monitoring's copy returned the whole row because its callers read the rest
  // of it, and `ClusterService.getSwarmToken` reads `ipAddress` off the same
  // return. Both are satisfied by the row and neither by a projection.
  it('resolves to the whole row for an owned id', async () => {
    const row = {
      serverId: 'server-1',
      name: 'ours',
      ipAddress: '203.0.113.7',
      port: 22,
      organizationId: 'org-1',
    } as Server;

    await expect(
      checkServerAccess(dbAnswering([row]), ctx, 'server-1'),
    ).resolves.toBe(row);
  });
});
