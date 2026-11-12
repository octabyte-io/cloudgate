import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { FrozenCarveOut } from '../../src/cloud/billing/allowed-when-frozen.decorator';

/**
 * **Every write a Frozen Organization may still make, written down**
 * (ADR-0052).
 *
 * `FrozenGuard` refuses every mutating route while the caller's active
 * Organization is frozen, unless the route carries `@AllowedWhenFrozen`. The
 * spec's list is short — paying, Delete a Service / Environment / Server,
 * disconnecting a Cloud account, deleting the Organization — so the
 * decorator's every use is held here, keyed `<path under src>#<handler>`,
 * with its carve-out. A new one fails until it is added on purpose; one that
 * went away fails until its entry does. The MCP dispatcher reads the same
 * decorator off a write tool's twin, so a tool is allowed exactly when its
 * twin is.
 *
 * `own-account` is the one carve-out beyond the spec's list: the caller's own
 * person (profile, two-factor, Personal keys, sessions, default Organization)
 * and another Organization (creating one, accepting an invitation) are not the
 * frozen Organization's work, and refusing them would trap a member in it.
 */
const ALLOWED: Record<string, FrozenCarveOut> = {
  'cloud/billing/billing.controller.ts#createCheckoutSession': 'pay',
  'cloud/billing/billing.controller.ts#createCustomerPortalSession': 'pay',
  'cloud/billing/billing.controller.ts#setAddOns': 'pay',
  // "Stop paying for it" from a frozen Paying Organization (ADR-0059): it
  // takes an Organization off a plan nobody is paying, and starts nothing.
  'cloud/billing/billing.controller.ts#stopPaying': 'detach',

  'applications/applications.controller.ts#remove': 'remove',
  'compose/compose.controller.ts#remove': 'remove',
  'databases/postgres/postgres.controller.ts#remove': 'remove',
  'databases/mysql/mysql.controller.ts#remove': 'remove',
  'databases/mariadb/mariadb.controller.ts#remove': 'remove',
  'databases/mongo/mongo.controller.ts#remove': 'remove',
  'databases/redis/redis.controller.ts#remove': 'remove',
  'databases/libsql/libsql.controller.ts#remove': 'remove',
  'buckets/buckets.controller.ts#remove': 'remove',
  // Cancel a Bought Server purchase still waiting for payment: it removes
  // the purchase and voids its invoice, and starts nothing (ADR-0071).
  'bought-servers/bought-servers.controller.ts#cancel': 'remove',
  // Backups on or off on a Bought Server: off only lowers what is owed, and
  // on, which charges, is refused while frozen by the service itself.
  'bought-servers/bought-servers.controller.ts#setBackups': 'remove',
  // A new size: down only lowers what is owed, and up, which charges, is
  // refused while frozen by the service itself.
  'bought-servers/bought-servers.controller.ts#setSize': 'remove',
  'environments/environments.controller.ts#remove': 'remove',
  'servers/servers.controller.ts#remove': 'remove',
  // Removes only the Project's Environments and Services, each allowed.
  'projects/projects.controller.ts#remove': 'remove',

  'cloud-accounts/cloud-accounts.controller.ts#remove': 'disconnect',

  'organizations/organizations.controller.ts#delete': 'delete-organization',

  'organizations/organizations.controller.ts#create': 'own-account',
  'organizations/organizations.controller.ts#acceptInvitation': 'own-account',
  'organizations/organizations.controller.ts#setDefault': 'own-account',
  'users/users.controller.ts#updateProfile': 'own-account',
  'users/users.controller.ts#enableTwoFactor': 'own-account',
  'users/users.controller.ts#verifyTwoFactor': 'own-account',
  'users/users.controller.ts#disableTwoFactor': 'own-account',
  'users/users.controller.ts#createApiKey': 'own-account',
  'users/users.controller.ts#deleteApiKey': 'own-account',
  'users/users.controller.ts#revokeSession': 'own-account',
  // An Operator's write acts on another Organization.
  'operator/operator.controller.ts#suspend': 'own-account',
  'operator/operator.controller.ts#lift': 'own-account',
  'operator/operator.controller.ts#setEnterprise': 'own-account',
  'operator/operator.controller.ts#setBoughtServerSettings': 'own-account',
  'operator/operator.controller.ts#deleteOrphanMachine': 'own-account',
  'operator/operator-abuse.controller.ts#forwardAbuseReport': 'own-account',
  'operator/operator-abuse.controller.ts#closeAbuseReport': 'own-account',
  'operator/operator-abuse.controller.ts#powerOffBoughtServer': 'own-account',
  'operator/operator-abuse.controller.ts#powerOnBoughtServer': 'own-account',
  'operator/operator.controller.ts#previewReprice': 'own-account',
  'operator/operator.controller.ts#applyReprice': 'own-account',
};

const srcRoot = join(__dirname, '..', '..', 'src');

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile() && path.endsWith('.ts')) found.push(path);
  }
  return found;
}

const DECLARATION =
  /^ {2}(?:(?:public|private|protected)\s+)?(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/;
const CARVE_OUT = /^@AllowedWhenFrozen\('([a-z-]+)'\)$/;

/** Every `@AllowedWhenFrozen` in `src`, by the handler it sits above. */
function decoratedHandlers(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const file of walk(srcRoot).sort()) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const carveOut = CARVE_OUT.exec(line.trim());
      if (!carveOut) return;
      for (let i = index + 1; i < lines.length; i += 1) {
        const declared = DECLARATION.exec(lines[i]);
        if (declared && !lines[i].trim().startsWith('@')) {
          found[`${relative(srcRoot, file)}#${declared[1]}`] = carveOut[1];
          return;
        }
      }
    });
  }
  return found;
}

describe('AllowedWhenFrozen: the writes a Frozen Organization may make', () => {
  it('carries the decorator on exactly the listed routes, each with its carve-out', () => {
    expect(decoratedHandlers()).toEqual(ALLOWED);
  });

  it('is never applied to a whole controller', () => {
    const classLevel = walk(srcRoot).filter((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .some((line) => line.startsWith('@AllowedWhenFrozen')),
    );
    expect(classLevel).toEqual([]);
  });
});
