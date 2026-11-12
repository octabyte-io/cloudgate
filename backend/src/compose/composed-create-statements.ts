import type { Permissions } from '../rbac/permission.service';

/**
 * Every statement a composed create's population loops are going to claim,
 * listed so the caller can claim them **before the first write**.
 *
 * A composed create (`AiService.deploy`) is several writes with nothing
 * scoping them to each other: `createByTemplate` commits the compose row,
 * `PermissionService.addNewService` grants it to the caller, then the mounts
 * and domains loops attach the definition. A refusal *inside* those loops
 * would land with the stack already committed and already the caller's, and
 * nothing cleans it up. So the statements the loops claim are claimed first:
 *
 * - `domain: ['create']`, which `DomainsService.create` asks for;
 * - `volume: ['create']`, which `MountsService.createForNewService` asks for;
 * - `service: ['read']`, the role half of the `checkServiceAccess(…, 'read')`
 *   both of them run, which a create authorized at `'create'` never asked.
 *
 * **They are separate `checkPermission` calls rather than one merged object,
 * and that is load-bearing.** `checkPermission`'s owner/admin bypass fires
 * only when *every* requested resource is in `enterpriseOnlyResources`;
 * `domain` and `volume` are, `service` is not. Merged with `service`, the two
 * enterprise-only statements would stop being bypassed for owner and admin,
 * and the pre-flight would refuse callers the loops admit. Emitted in a fixed
 * order so a refusal is the same one whichever caller asked.
 *
 * **Conditional on the loops actually running**: a stack with no mounts
 * reaches no `volume` gate and must not start being refused by one. An empty
 * list is the honest answer for a stack with neither.
 *
 * It lived beside the `template.toml` deploy until that was removed
 * (ADR-0066); a Template setup asks every Apply statement first on the same
 * reasoning (ADR-0065).
 */
export function composedCreateStatements(populates: {
  domains: number;
  mounts: number;
}): Permissions[] {
  if (populates.domains === 0 && populates.mounts === 0) return [];
  const claims: Permissions[] = [{ service: ['read'] }];
  if (populates.domains > 0) claims.push({ domain: ['create'] });
  if (populates.mounts > 0) claims.push({ volume: ['create'] });
  return claims;
}
