import { api } from "../client";

/**
 * What a role in this Organization is allowed to do.
 *
 * **Two of these five routes are open and three are licensed**, and the split is
 * the whole reason this module is F16's and the screens on top of it are shared
 * with F18. `custom-role.controller.ts` puts `GET /custom-roles`,
 * `GET /custom-roles/statements` and `GET /custom-roles/:roleName/members` on
 * the plain authenticated path; `POST`, `PATCH` and `DELETE` all run
 * `ensureEnterprise`, which needs an owner or admin **and** a valid enterprise
 * licence. So an unlicensed instance can *read* the permission vocabulary and
 * every role built from it, assign those roles to members, and change nothing
 * about them.
 *
 * F16 therefore shipped the reading half — the permission grid, the three static
 * roles rendered from it, and the member table's role picker — and **F18 has
 * made the grid writable**, which is what its brief asks for ("reuse the editor
 * and feed it `GET /custom-roles/statements`"). The three writes are at the
 * bottom of this module and every one of them is licensed.
 *
 * `statements` is `rbac/access-control.ts` returned verbatim, so the grid offers
 * exactly the subject/action pairs the guards check and cannot drift from them.
 *
 * **Three constants left this module.**
 * `STATIC_ROLE_PERMISSIONS`, `ENTERPRISE_ONLY_RESOURCES` and
 * `INTERNAL_RESOURCES` were transcriptions of backend source with no route
 * behind them, kept in step by hand, and they had drifted in both directions —
 * an action missing from a role's entry rendered as "not allowed" for a
 * caller who held it, and entries for statements that no longer
 * existed rendered nowhere and so read as correct forever. They are fields
 * on {@link RoleVocabulary} now, and the backend serves the very objects its own
 * guards consult. The only role fact still written down on this side is
 * {@link STATIC_ROLES}, and its docblock says why that one is a contract rather
 * than a copy.
 */

/** `GET /custom-roles/statements` — resource → the actions it defines. */
export type PermissionStatements = Record<string, string[]>;

/** A role's grants: resource → the actions this role holds. */
export type RolePermissions = Record<string, string[]>;

/**
 * `GET /custom-roles/statements` — the permission vocabulary and everything
 * needed to read it.
 *
 * `CustomRolesService.getStatements`'s `RoleVocabulary`, and its docblock
 * carries the decision: one response rather than sibling routes, because every
 * screen that renders the catalogue also annotates it from the other three
 * fields in the same paint, and all four are constants of the running build
 * rather than rows.
 *
 * **All four fields are what the backend itself consults.** `staticRoles` hands
 * out the grant maps `PermissionService.checkPermission` authorizes against —
 * better-auth's `role()` keeps the object `ac.newRole` was given, so there is no
 * copy to go stale — `enterpriseOnlyResources` is the set that method's
 * owner/admin bypass reads, and `internalResources` is the list
 * `validatePermissions` refuses.
 */
export interface RoleVocabulary {
  /** Resource → the actions it defines. What `PermissionGrid` renders a row per. */
  statements: PermissionStatements;
  /** `owner` / `admin` / `member` → the grants that built-in role holds. */
  staticRoles: Record<string, RolePermissions>;
  /**
   * The resources a **static** role is never checked on at all, so a tick
   * against one of them in `owner`'s column describes a rule that is not
   * evaluated. The grid says so; withholding that would be the most misleading
   * thing on the screen.
   */
  enterpriseOnlyResources: string[];
  /**
   * The resources a custom role cannot be given — membership and Organization
   * lifecycle, which better-auth's organization plugin owns. The builder
   * disables these rows, so the refusal is unreachable through the UI.
   */
  internalResources: string[];
}

/**
 * One role, as `GET /custom-roles` merges it.
 *
 * `ids` is a list because the service unions rows that share a name — the table
 * has no unique constraint on `(organizationId, role)`, so two rows can carry
 * the same name and their grants are merged per resource.
 */
export interface CustomRole {
  role: string;
  permissions: RolePermissions;
  createdAt: string;
  ids: string[];
  memberCount: number;
}

/** Who holds a role — `GET /custom-roles/:roleName/members`. */
export interface RoleMember {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
}

/** `createCustomRoleSchema` / `updateCustomRoleSchema`. */
export interface CustomRoleInput {
  roleName: string;
  permissions: RolePermissions;
}

export const rolesApi = {
  /**
   * The permission vocabulary. One constant for the whole deployment — it is
   * `statements`, the three `ac.newRole` calls and two sets in the backend's
   * source, not a row — which is why its key sits under `instance` rather than
   * under the Organization.
   */
  vocabulary: () => api.get<RoleVocabulary>("/custom-roles/statements"),

  /** The Organization's custom roles. Empty on an unlicensed instance. */
  list: () => api.get<CustomRole[]>("/custom-roles"),

  members: (roleName: string) =>
    api.get<RoleMember[]>(
      `/custom-roles/${encodeURIComponent(roleName)}/members`,
    ),

  /**
   * **The three writes, added by F18.** All `ensureEnterprise`: owner or admin
   * plus a valid licence, so each is a `403 Valid enterprise license required`
   * on an unlicensed instance — which is why the builder is inside a
   * `LicenseGate` and the grid above stays readable outside one.
   *
   * Four refusals the screen has to route rather than swallow, all of them
   * things the form can be right about before sending:
   *
   * - **Ten names per Organization.** `create` counts *distinct role names* and
   *   400s at ten.
   * - **`owner` / `admin` / `member` are reserved**, refused by `roleNameSchema`
   *   itself, so this arrives as a field issue on `roleName`.
   * - **A duplicate name is a 409**, which `useApiForm` puts on the field.
   * - **A role in use cannot be deleted** — a 400 naming how many members hold
   *   it. There is no cascade and no reassign: the members move first.
   *
   * And one the form must not allow at all: `validatePermissions` refuses
   * `organization`, `invitation`, `team` and `ac` outright. `PermissionGrid`
   * already disables those rows, from the `internalResources` this same response
   * carries, so the refusal is unreachable through the UI — which is the point
   * of feeding the builder the vocabulary rather than a hand-written list.
   */
  create: (input: CustomRoleInput) =>
    api.post<{ id: string; role: string }>("/custom-roles", input),

  /**
   * `PATCH /custom-roles/:roleName`. `newRoleName` renames, and **a rename moves
   * every member holding it** — `member.role` is the join key, so the backend
   * updates those rows in the same call. Omit it to change grants only.
   */
  update: (
    roleName: string,
    input: { newRoleName?: string; permissions: RolePermissions },
  ) =>
    api.patch<{ id: string; role: string }>(
      `/custom-roles/${encodeURIComponent(roleName)}`,
      input,
    ),

  remove: (roleName: string) =>
    api.delete<{ deleted: number }>(
      `/custom-roles/${encodeURIComponent(roleName)}`,
    ),
};

/**
 * The three built-in role names.
 *
 * **The one role fact still written down on this side, and it survived on
 * purpose.** It is not a transcription of grants: it is the reserved-name
 * contract, spelled the same way in `roleNameSchema` (which refuses these three
 * for a custom role) and in `CustomRolesService.STATIC_ROLES` (which refuses to
 * modify or delete them). Three things need it *before* any request has landed —
 * `usePermission` decides from it whether to fetch `GET /custom-roles` at all,
 * and `RoleLicenceNotices` and `RolePreview` ask "is this name a built-in one"
 * to choose their copy — so reading it out of {@link RoleVocabulary} would make
 * a name test wait on a round trip and answer "custom" for owner in the
 * meantime, which is the wrong way to be wrong about a licence notice.
 *
 * The grants those names carry come from `staticRoles` on the served vocabulary,
 * and that is why: those drifted, a name list cannot.
 */
export const STATIC_ROLES = ["owner", "admin", "member"];

/**
 * The Agent-only role names, `AGENT_ROLES` in the backend's
 * `access-control.ts`, verbatim and in order — `audit-logs.test.ts` holds the
 * two lists equal.
 *
 * Only an Agent can hold one and an Agent can hold nothing else, so a role
 * name is enough to tell an Agent from a person on a row that no longer has
 * its user behind it: the audit log reads a row's `userRole` this way.
 */
export const AGENT_ROLES = [
  "agentReader",
  "agentOperator",
  "agentCaller",
] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export function isAgentRole(role: string): role is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(role);
}

/** What the console calls each agent role: the specs' Reader, Operator and Caller. */
export const AGENT_ROLE_LABELS: Record<AgentRole, string> = {
  agentReader: "Reader",
  agentOperator: "Operator",
  agentCaller: "Caller",
};
