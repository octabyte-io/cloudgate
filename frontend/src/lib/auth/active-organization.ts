import { unwrap } from "./auth-error";
import { getSession, organization } from "./client";
import { SELECT_ORGANIZATION_PATH, withNext } from "./routes";

/**
 * Nobody reaches the console without an active Organization.
 *
 * Every console read waits on the session's `activeOrganizationId` (§3.5's
 * `enabled: organizationId !== null`), so a session without one paints the
 * shell over skeletons that never resolve — and a caller who belongs to nothing
 * is refused by every controller with `ForbiddenException('No active
 * organization')`, which reads as a role problem.
 *
 * The backend's session `create.after` hook (`auth.config.ts`) sets it when the
 * answer is already known: the membership marked default, or the only one.
 * Two cases are left to this, on purpose:
 *
 * - **No memberships at all.** Someone who signed up against an invitation gets
 *   no membership until they accept it — `bootstrapDefaultOrganization` only
 *   fires for the very first user. There is nothing to choose here, so saying so
 *   beats offering an empty list.
 * - **Several, and no default**. Then it is genuinely a question, and
 *   asking is better than picking on their behalf: the Organization is the
 *   tenant boundary, and landing in the wrong one is confusing in a way that is
 *   hard to notice. The hook used to answer it with the most recently joined
 *   one, which made `choose` unreachable from sign-in; it now leaves it unset
 *   so that this asks.
 */
export type OrganizationDestination =
  | { kind: "ready"; href: string }
  | {
      kind: "choose";
      href: string;
      /** What `/select-organization` offers, read once here rather than twice. */
      organizations: { id: string; name: string }[];
    }
  | { kind: "none" };

/**
 * Read the session that was just created and decide where to send them.
 *
 * `getSession()` rather than the `useSession` store: this runs immediately after
 * a sign-in, and the store is not the authority on a session that is one
 * response old.
 */
export async function resolveOrganizationDestination(
  next: string,
): Promise<OrganizationDestination> {
  const session = await unwrap(getSession());
  const activeOrganizationId = (
    session?.session as { activeOrganizationId?: string | null } | undefined
  )?.activeOrganizationId;

  if (activeOrganizationId) return { kind: "ready", href: next };

  const organizations = await unwrap(organization.list());

  if (!organizations || organizations.length === 0) return { kind: "none" };

  if (organizations.length === 1) {
    // One membership and no default is a state the backend's hook should have
    // settled; setting it here costs one request and removes a whole class of
    // "everything says I do not have permission".
    await unwrap(
      organization.setActive({ organizationId: organizations[0].id }),
    );
    return { kind: "ready", href: next };
  }

  return {
    kind: "choose",
    href: withNext(SELECT_ORGANIZATION_PATH, next),
    organizations,
  };
}
