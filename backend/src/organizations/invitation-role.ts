import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The custom role an invitation is being created on, handed from
 * `OrganizationsService.inviteMember` to better-auth's `beforeCreateInvitation`
 * hook.
 *
 * **Why a hand-off at all.** `createInvitation` only accepts a role it can
 * resolve itself: its own `defaultRoles`, `orgOptions.roles`, or — behind
 * `dynamicAccessControl` — an `organizationRole` row
 * (`plugins/organization/routes/crud-invites.mjs` in the installed 1.6.33).
 * `createAuth` passes none of those, deliberately (`internalResources` in
 * `rbac/access-control.ts` carries why), so a custom role name is answered
 * `ROLE_NOT_FOUND` before any hook runs. The hook runs *after* that check and
 * before the row is written, and whatever `role` it returns is the role the
 * row is written with — which is the role `acceptInvitation` copies onto the
 * membership, and the one the invitation email names.
 *
 * So the service validates the custom role itself (defined in this
 * Organization, licensed — the rules `updateMemberRole` applies), asks
 * better-auth for a `member` invitation so its own checks run unchanged, and
 * the hook swaps the role in before anything is stored. No `member` invitation
 * ever exists, so there is no `member` state for the invitee to accept into.
 *
 * **Why `AsyncLocalStorage` rather than a body field.** A field on the body
 * is whatever the caller sent, and nothing but the service has validated it.
 * The store is only ever set by the service, in-process, around its own
 * `auth.api.createInvitation` call. better-auth's
 * `/api/auth/organization/invite-member` is in `disabledPaths`, so no
 * request reaches the plugin's route; were it reopened, it would run with no
 * store and the hook would leave its invitation alone.
 */
export const customInvitationRole = new AsyncLocalStorage<string>();

/** better-auth's `organizationHooks.beforeCreateInvitation`. */
export function substituteCustomInvitationRole() {
  const role = customInvitationRole.getStore();
  return Promise.resolve(role === undefined ? undefined : { data: { role } });
}
