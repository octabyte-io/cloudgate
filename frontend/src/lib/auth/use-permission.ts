import { useQuery } from "@tanstack/react-query";

import {
  STATIC_ROLES,
  rolesApi,
  type CustomRole,
  type RolePermissions,
  type RoleVocabulary,
} from "@/lib/api/endpoints/roles";
import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useRoleVocabulary } from "@/lib/api/use-role-vocabulary";

import { useActiveMemberRole, useActiveOrganizationId } from "./client";

/**
 * May this caller do the thing the control in front of them offers?
 *
 * **Built once, on purpose**.
 * Every feature surface in the console rendered its controls on the assumption
 * that whoever reached the screen could act on it, and discovered otherwise from
 * a refusal: the base member lost `project: ['update']`, so Save on a
 * Project and the Tags picker on the Projects list started answering 403 to a
 * form somebody had already filled in, and
 * `@RequirePermission('service','create')` on `POST /templates/preview` (since
 * removed with the `template.toml` reader) meant a member walked the whole
 * template wizard and failed at the review step. Those
 * are one gap and not three, and more of the same shape was coming on the
 * Service surfaces, so the answer is a hook rather than a check per feature.
 *
 * **Nothing already existed, and the two things that look like they do are dead
 * ends.** Both were checked before this was written, because §3.7 says the auth
 * client is the one client and that a flow which feels missing is probably on it
 * under a name we have not looked for:
 *
 * - **`organization.checkRolePermission`** authorizes client-side against the
 *   `ac` and `roles` handed to `organizationClient`, and `client.ts` hands it
 *   neither — so it falls back to better-auth's own `defaultRoles`, whose
 *   statements are `organization`, `member`, `invitation`, `team` and `ac`. It
 *   answers `false` for `project: ['update']` for an owner as readily as for a
 *   member, which is not a narrower answer but a wrong one.
 * - **`POST /organization/has-permission`** is a real round trip, and it reads
 *   the same `options.roles` on the server side. `createAuth`'s `organization({
 *   … })` passes no `ac`, no `roles` and no `dynamicAccessControl`, so it too
 *   answers off `defaultRoles` — and the DB branch that would read a custom
 *   role's grants is behind the `dynamicAccessControl` flag this build does not
 *   set. Cloudgate's own statements live in `rbac/access-control.ts` and are
 *   enforced by `PermissionService.checkPermission`, which better-auth's
 *   organization plugin knows nothing about.
 *
 * So the vocabulary has to be reassembled on this side, and the pieces were
 * already here for the roles editor: the three built-in roles' grants, the
 * Organization's custom ones from `rolesApi.list` with their rows already
 * unioned per resource, and the set a static role never has checked at all.
 * What was missing is the caller's *own* role, which is
 * `authClient.useActiveMemberRole` — a better-auth endpoint that asks only for
 * membership, so a base member is not refused the read that tells them what they
 * may do.
 *
 * **Two of those three pieces now arrive over the wire**, and this hook
 * is why that was worth doing rather than tidying. They were
 * `STATIC_ROLE_PERMISSIONS` and `ENTERPRISE_ONLY_RESOURCES`, transcriptions of
 * backend source with no route behind them, and this is the file that turned
 * their drift into a *wrong answer*: an action missing from a role's entry read
 * here as "not allowed" for a caller who held it, and the reverse happened
 * too. `useRoleVocabulary` serves both from the objects
 * `PermissionService` itself authorizes against.
 *
 * **It is advisory, and it fails open.** The backend is the authorization; this
 * only decides whether to offer a control. So every uncertainty — the role read
 * still in flight, the role read refused, **the vocabulary read still in flight
 * or refused**, a custom role whose grants this console cannot see because the
 * enterprise licence that resolves it has lapsed — comes back `allowed`, and the
 * caller meets the backend's refusal, which every gated surface now renders as
 * an explanation rather than a status code. The other direction is worse by a
 * wide margin: a hook that guessed "no" would take Save away from an owner over
 * a dropped request, and there is no refusal to explain that.
 *
 * **That is the whole of what serving the vocabulary had to be careful about
 * here, and §3.5 names the trap: a refusal is not an empty list.** Before, a
 * static role's
 * verdict needed no request, so `pending` was never true for one; now the grants
 * arrive with everything else. The one thing that must not happen is answering
 * "not allowed" while they are in flight — a missing grant map and an empty
 * grant map are the same object shape, and treating the first as the second
 * would reproduce the old failure in the very change that fixes it.
 * {@link resolveGrants} therefore returns `null` and not `{}` for a static role
 * whose grants have not arrived, which lands in the `grants === null` branch
 * below that already fails open for the lapsed-licence case. Both directions are
 * pinned in `use-permission.test.ts`.
 *
 * **Rejected: gating on the static role name** (`role === "owner" || role ===
 * "admin"`). It is one line and it is what the two surfaces would have needed
 * today, and it is exactly the shape that keeps breaking: a licensed
 * custom role granted `project: ['update']` is neither, and the base member's
 * grants have now moved twice. The statement is the thing the guard checks, so
 * the statement is the thing this takes.
 */

/**
 * The statements a surface needs, in `PermissionService`'s own shape — one
 * resource to the actions required on it.
 *
 * Loosely typed against `Record<string, string[]>` rather than derived from the
 * backend's `statements`, which is a const object in a package this app does not
 * import. `GET /custom-roles/statements` is the served copy and the permission
 * grid renders it; a resource misspelled here therefore fails open like any
 * other unknown, rather than compiling into a control nobody can use.
 */
export type RequiredPermissions = Record<string, string[]>;

/** What a gated control needs to know. */
export type PermissionVerdict = {
  /**
   * Offer the control. False only when the caller's role is known *and* known
   * not to carry every requested action.
   */
  allowed: boolean;
  /**
   * The role is not established yet, so `allowed` is a guess in the safe
   * direction. A screen whose whole point is the gated action renders its
   * pending state on this; a button on a screen that does other things as well
   * just stays live for the one round trip.
   */
  pending: boolean;
  /** The caller's role in the active Organization, once it is known. */
  role: string | null;
};

/** The facts {@link permissionVerdict} decides from. */
export type RoleFacts = {
  /** `member.role` for the active Organization, or `null` until it arrives. */
  role: string | null;
  /** One of the reads this needs — role, vocabulary, custom roles — is in flight. */
  pending: boolean;
  /**
   * The Organization's custom roles, or `undefined` while unread. Only consulted
   * for a role that is not one of the three static names.
   */
  customRoles: CustomRole[] | undefined;
  /**
   * The served vocabulary, or `undefined` while unread or refused. It
   * carries the three built-in roles' grants and the enterprise-only set, so
   * without it a static role's verdict is a guess in the safe direction rather
   * than a refusal — see this module's note on §3.5.
   */
  vocabulary: RoleVocabulary | undefined;
};

/**
 * The decision, as a pure function of the facts — `console-gate.ts`'s shape, for
 * its reason: the interesting part is a table, and a table is worth reading and
 * testing without a React tree around it.
 *
 * It mirrors `PermissionService.checkPermission`, including the one branch that
 * looks like it could be dropped: an owner or admin skips the check outright
 * when *every* requested resource is enterprise-only, because those statements
 * exist to constrain licensed custom roles and a static role never has them
 * checked. Neither of the first two gated surfaces asks about such a resource, so the
 * branch is unreachable from here today — it is here so this stays a mirror of
 * the guard rather than a paraphrase of the two cases that prompted it.
 */
export function permissionVerdict(
  facts: RoleFacts,
  required: RequiredPermissions,
): PermissionVerdict {
  const { role } = facts;

  if (role === null) {
    return { allowed: true, pending: facts.pending, role: null };
  }

  const resources = Object.keys(required);

  if (role === "owner" || role === "admin") {
    // An unread vocabulary makes this branch unreachable rather than wrong: an
    // empty set means `allEnterprise` is false and the fall-through below fails
    // open anyway, so both paths agree while the read is in flight.
    const bypassed = facts.vocabulary?.enterpriseOnlyResources ?? [];
    const allEnterprise = resources.every((resource) =>
      bypassed.includes(resource),
    );
    if (allEnterprise) return { allowed: true, pending: false, role };
  }

  const grants = resolveGrants(facts);
  if (grants === null) {
    // Nothing on this side defines the name. The vocabulary has not arrived, or
    // the custom-role list has not, or it arrived without this role in it —
    // which is what a lapsed enterprise licence looks like from here, and is the
    // case the backend refuses outright. Fail open and let it say so.
    return { allowed: true, pending: facts.pending, role };
  }

  const allowed = resources.every((resource) =>
    required[resource].every((action) =>
      (grants[resource] ?? []).includes(action),
    ),
  );

  return { allowed, pending: false, role };
}

/**
 * Resource → the actions this role holds, or `null` when the role name resolves
 * to nothing this console can see.
 *
 * A custom role's rows are already unioned per resource by the time they get
 * here — `CustomRolesService` does it, because `member.role` is the join key and
 * the table has no unique constraint on the name — so this reads one row's
 * `permissions` rather than merging a set.
 *
 * **`null` for a static role whose grants have not arrived, never `{}`.**
 * That is the whole of §3.5's "a refusal is not an empty list" on this side: an
 * empty grant map is a role that holds nothing, and an unread one is a question
 * nobody has answered yet. Returning the first for the second would answer "not
 * allowed" for an owner for as long as one request takes.
 */
function resolveGrants(facts: RoleFacts): RolePermissions | null {
  const { role } = facts;
  if (role === null) return null;
  if (STATIC_ROLES.includes(role)) {
    return facts.vocabulary?.staticRoles[role] ?? null;
  }
  const match = facts.customRoles?.find((entry) => entry.role === role);
  return match?.permissions ?? null;
}

/**
 * {@link permissionVerdict} over the live session.
 *
 * Adding a second required statement is adding a key: `usePermission({ service:
 * ["create"], server: ["read"] })` is the whole of what is asked of the
 * template arms that take a `serverId`, and nothing in the verdict has to know
 * that two statements are in play rather than one.
 *
 * `required` is read on every render and deliberately not a dependency of
 * anything — it is an object literal at every call site, so memoising on it
 * would memoise on a new identity each time. The custom-role query is keyed on
 * the Organization instead, and shares `keys.roles.list`'s cache with the
 * members screen that already reads it.
 *
 * **Two reads, and only one of them can multiply.** The vocabulary is a
 * single instance-scoped key with `staleTime: Infinity`, so a gated control on
 * every screen is that one cache entry and not a request each — which is the
 * same argument `enabled` makes for the custom-role list one line down, made by
 * the key instead. It is also already warm on the two screens that render the
 * permission grid.
 */
export function usePermission(
  required: RequiredPermissions,
): PermissionVerdict {
  const { organizationId } = useActiveOrganizationId();
  const activeRole = useActiveMemberRole();
  const vocabulary = useRoleVocabulary();

  const role = activeRole.data?.role ?? null;
  const custom = role !== null && !STATIC_ROLES.includes(role);

  /**
   * Only for a custom role. The three static names are answered from the
   * vocabulary's `staticRoles`, which every reader on the instance shares, so
   * the overwhelmingly common case costs no request of its own — and `enabled`
   * is what keeps a gated button on every screen from putting
   * `GET /custom-roles` behind it.
   */
  const customRoles = useQuery({
    queryKey: keys.roles.list(organizationId),
    queryFn: rolesApi.list,
    enabled: organizationId !== null && custom,
  });

  return permissionVerdict(
    {
      role,
      pending:
        activeRole.isPending ||
        vocabulary.isPending ||
        (custom && customRoles.isPending),
      customRoles: customRoles.data,
      vocabulary: vocabulary.data,
    },
    required,
  );
}

/*
 * **The rule for every create or destructive control
 * **
 *
 * A control whose action the caller cannot take is **off before it is pressed,
 * with the reason on it** — `Button`'s `disabled`, which Base UI renders as
 * `aria-disabled` so it keeps its tab stop, plus a `title` and, where a card has
 * room, the same sentence beside it. New Project on `/projects` was the one
 * control that did this; everything else opened its form, took the input and
 * met the 403 on submit, so the same role got both behaviours a screen apart.
 * It is decided by what the route behind the control authorizes on:
 *
 * 1. **A statement** — `@RequirePermission` on the route, or the
 *    `checkPermission` / `findOwnedForUpdate` its service runs first, or
 *    better-auth's own check for the organization plugin's routes. The control
 *    reads {@link usePermission} with that statement and a sentence built by
 *    {@link roleRefusal}. **Only a statement every caller the route admits
 *    holds**: gating on anything else could turn off a control that would have
 *    worked, which is the one failure this module refuses to risk. A route that
 *    also asks something narrower (a row-level grant, an owner-or-admin check
 *    on top) keeps the control live for whoever holds the statement and lets
 *    the backend refuse the rest, exactly as before — never the other way
 *    round. That is also why the member rows' Change role and an invitation's
 *    Delete read `member: ['update']` and `invitation: ['cancel']`: their
 *    services admit owner and admin only, and both hold those statements, which
 *    are the vocabulary's own names for the two acts.
 * 2. **No statement names it** — AI providers (`AiService.ensureOwnerOrAdmin`)
 *    and instance authority (ADR-0013: `/settings/instance`,
 *    `/settings/maintenance`). Borrowing an unrelated statement would be a
 *    claim nobody could check, and naming the role is rejected above. What the
 *    console does have is **the read on the same surface, which takes the same
 *    authority** (ADR-0013's "reads move with writes"): once that read has been
 *    refused, every write beside it would be. {@link readGate} turns the
 *    refusal into the same off control, with the backend's own sentence as the
 *    reason. Until the read answers the controls stay live, on this module's
 *    fail-open argument.
 * 3. **An ADR says otherwise.** The one today is ADR-0010's host shell form
 *    (`local-shell-card.tsx`): "a form hidden behind a role read in the
 *    browser is a claim about authority made where the caller controls the
 *    answer", so it is rendered for everyone and its refusal is the gateway's.
 *
 * **A confirmation step is not a second control.** The Delete inside a dialog is
 * reached only through the opener, and the opener is what carries the gate.
 *
 * **A read is not a create or destructive control, and stays live.** Check for
 * updates on `/settings/instance` is the one the table listed:
 * `POST /settings/update-data` carries no decorator and admits any signed-in
 * user ("A POST, though it writes nothing"), so there is nothing to gate it on.
 *
 * `gated-controls.ts` is the register of every control this rule has been
 * applied to — its statement, and the route that statement was read off — and
 * `gated-controls.test.ts` is the census that keeps a new screen from
 * reintroducing the split: a create or destructive control that is neither in
 * the register nor named in its baseline fails it, and so does a
 * `SettingsCard` or `VariablesCard` rendered without a `gate` that is not
 * named in the card baseline, and a Save anywhere else that is neither gated
 * nor named in the Save baseline or its exemptions.
 */

/**
 * What a shared control component is handed when the statement is its
 * caller's to know — `VariablesCard`, a `DangerZone` row: whether to offer it,
 * and the sentence to say when not.
 */
export type Gate = { allowed: boolean; refusal: string };

/**
 * The sentence an off control carries, in the words `errorMessage()` gives the
 * backend's own 403 — "Your role in this Organization does not allow this. Ask
 * an owner or an admin to do it, or to change your role." — with the action
 * named, so a member who reaches the refusal anyway is not told two different
 * things. `action` is a verb phrase: `"invite someone"`, `"add a Server"`.
 */
export function roleRefusal(action: string): string {
  return `Your role in this Organization cannot ${action}. Ask an owner or an admin to do it, or to change your role.`;
}

/**
 * A {@link Gate} from a read that takes the same authority as the controls
 * beside it — case 2 of the rule above.
 *
 * Off only on a **403**: that is the backend saying who may be here. Anything
 * else — pending, a 500, the network — says nothing about the caller, and the
 * control stays live for the backend to answer. The reason is the refusal's own
 * sentence (`errorMessage`), so a banned account is told it is banned rather
 * than that its role is the problem (H-26).
 */
export function readGate(read: { error: unknown }): Gate {
  const refused = isApiError(read.error) && read.error.isForbidden;
  return {
    allowed: !refused,
    refusal: refused ? errorMessage(read.error) : "",
  };
}
