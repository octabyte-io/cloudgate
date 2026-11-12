import { and, count, countDistinct, eq, inArray, notExists } from 'drizzle-orm';
import { application } from '../../applications/application.schema';
import { account } from '../../auth/auth.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import { domain } from '../../domains/domain.schema';
import {
  displayName,
  strandedMembersOf,
} from '../../enterprise/license/license-lapse.service';
import { scimProvider } from '../../enterprise/scim/scim.schema';
import { ssoProvider } from '../../enterprise/sso/sso.schema';
import { environment } from '../../environments/environment.schema';
import { member } from '../../organizations/organizations.schema';
import { project } from '../../projects/project.schema';

/** One person holding a custom role, which allows nothing on Starter. */
export interface CustomRoleHolder {
  /** Their name, or their email when none was recorded. */
  name: string;
  /** The custom role they hold. */
  role: string;
}

/**
 * **What moving to Starter stops, against what this Organization uses**
 * (ADR-0054): the facts the downgrade confirm lists. A paid feature
 * the Organization never set up is zero or empty here, and the confirm
 * leaves it out.
 *
 * "Set up" is what the paid-feature pages count as kept below Business
 * an SSO provider, a SCIM connection, a custom role someone holds,
 * a domain behind forward auth.
 */
export interface DowngradeImpactView {
  /** The Organization's SSO providers; SSO sign-in stops for all of them. */
  ssoProviders: number;
  /**
   * Members who sign in only through one of those providers (an SSO account,
   * no password): on Starter they use "Forgot password" to set one.
   */
  ssoOnlyPeople: number;
  /**
   * The Organization's SCIM connections: on Starter their adds are refused,
   * and their removals still work.
   */
  scimProviders: number;
  /** Everyone holding a custom role, by name. */
  customRoleHolders: CustomRoleHolder[];
  /**
   * Applications with a domain behind forward auth: they stay protected, and
   * forward auth can no longer be added or changed.
   */
  protectedApps: number;
}

/**
 * The facts, read straight off the tables. A plain function, as
 * `strandedMembersOf`: the billing module cannot inject the paid-feature
 * services (they sit behind LicenseService and PermissionService).
 */
export async function downgradeImpactOf(
  db: DrizzleDB,
  organizationId: string,
): Promise<DowngradeImpactView> {
  const [ssoProviders, scimProviders, ssoOnlyPeople, holders, protectedApps] =
    await Promise.all([
      countSsoProviders(db, organizationId),
      countScimProviders(db, organizationId),
      countSsoOnlyPeople(db, organizationId),
      strandedMembersOf(db, organizationId),
      countProtectedApps(db, organizationId),
    ]);
  return {
    ssoProviders,
    ssoOnlyPeople,
    scimProviders,
    customRoleHolders: holders.map((person) => ({
      name: displayName(person),
      role: person.role,
    })),
    protectedApps,
  };
}

async function countSsoProviders(
  db: DrizzleDB,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, organizationId));
  return row?.n ?? 0;
}

async function countScimProviders(
  db: DrizzleDB,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(scimProvider)
    .where(eq(scimProvider.organizationId, organizationId));
  return row?.n ?? 0;
}

/**
 * Members with an account at one of this Organization's SSO providers (the
 * SSO plugin names the account by the provider's id) and no `credential`
 * account, which is what holds a password.
 */
async function countSsoOnlyPeople(
  db: DrizzleDB,
  organizationId: string,
): Promise<number> {
  const providerIds = db
    .select({ id: ssoProvider.providerId })
    .from(ssoProvider)
    .where(eq(ssoProvider.organizationId, organizationId));
  const password = db
    .select({ id: account.id })
    .from(account)
    .where(
      and(
        eq(account.userId, member.userId),
        eq(account.providerId, 'credential'),
      ),
    );
  const [row] = await db
    .select({ n: countDistinct(member.userId) })
    .from(member)
    .innerJoin(account, eq(account.userId, member.userId))
    .where(
      and(
        eq(member.organizationId, organizationId),
        inArray(account.providerId, providerIds),
        notExists(password),
      ),
    );
  return row?.n ?? 0;
}

/** Applications of this Organization with a domain forward auth gates. */
async function countProtectedApps(
  db: DrizzleDB,
  organizationId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: countDistinct(domain.applicationId) })
    .from(domain)
    .innerJoin(application, eq(domain.applicationId, application.applicationId))
    .innerJoin(
      environment,
      eq(application.environmentId, environment.environmentId),
    )
    .innerJoin(project, eq(environment.projectId, project.projectId))
    .where(
      and(
        eq(project.organizationId, organizationId),
        eq(domain.forwardAuthEnabled, true),
      ),
    );
  return row?.n ?? 0;
}
