import { ConflictException } from '@nestjs/common';

import type { DomainsService } from '../../domains/domains.service';
import { serverIdOf } from '../../environments/deploy-target';
import type { PermissionCtx } from '../../rbac/permission.service';
import type { DeployTarget, TemplateDomain } from '../planner/plan.types';

/**
 * Which of a Template's picked Domain hosts are taken, each with why
 * (ADR-0065: "hosts are checked before anything is written"). The rules are
 * `DomainsService`'s own, never a copy: one Domain per exact host and path
 * across every organization, and a host another organization claims on the
 * same Server; in a Cloud Environment, a cloud Domain's, where only the
 * Organization's own Domains count (ADR-0060). Two Domains of the same setups naming one host and path is
 * taken too, since only one of them could be made.
 *
 * Read when a plan is made, so the plan refuses it, and again by the Apply
 * before any step writes, since a host can be taken in between. The caller
 * has authorized the Environment first: "this host is taken" is an answer
 * about other organizations' rows (`assertHostsUnclaimed`'s precondition).
 */
export async function takenTemplateHosts(
  domains: DomainsService,
  ctx: PermissionCtx,
  deployTarget: DeployTarget,
  wanted: readonly TemplateDomain[],
): Promise<Map<string, string>> {
  const serverId = serverIdOf(deployTarget);
  const taken = new Map<string, string>();
  const seen = new Set<string>();
  for (const { host, path } of wanted) {
    const route = JSON.stringify([host, path]);
    if (seen.has(route)) {
      taken.set(host, `another Domain of a setup here names it at ${path}`);
      continue;
    }
    seen.add(route);
    try {
      if (deployTarget.kind === 'cloud') {
        // A cloud Domain's rules (#1379): only this Organization's count.
        await domains.assertCloudRouteUntaken(ctx, { host, path });
      } else {
        await domains.assertRoutesUntaken(ctx, [{ host, path }]);
        await domains.assertHostsUnclaimedInOrganization(
          ctx.session.activeOrganizationId,
          [host],
          serverId,
        );
      }
    } catch (error) {
      if (!(error instanceof ConflictException)) throw error;
      taken.set(host, error.message);
    }
  }
  return taken;
}
