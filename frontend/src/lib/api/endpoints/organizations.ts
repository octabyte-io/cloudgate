import { api } from "../client";

/**
 * `organizations.controller.ts`. The Organization is the tenant boundary: every
 * other query key hangs off the active one.
 *
 * Create, update and delete live here rather than on better-auth's client on
 * purpose — `auth.config.ts` disables `/organization/create|update|delete`
 * because these routes enforce the self-hosted owner rules the plugin does not.
 * Switching the active Organization is the opposite case: that *is*
 * better-auth's (`organization.setActive` in `src/lib/auth/client.ts`).
 */

/** The `organization` row. `ownerId` is a Cloudgate column, not the plugin's. */
export interface Organization {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  createdAt: string;
  metadata: string | null;
  ownerId: string;
}

/**
 * The `member` row. `owner` and `admin` are the static roles; anything else is
 * a custom role the Organization defined. The `accessed*` arrays are the
 * row-level grants that decide what a non-privileged role can see at all.
 */
export interface Member {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: string;
  isDefault: boolean;
  accessedProjects: string[];
  accessedServices: string[];
  accessedEnvironments: string[];
}

/** `GET /organizations` — the caller's Organizations, each with their own row. */
export interface OrganizationMembership extends Organization {
  member: Member;
  /**
   * Who pays for it (ADR-0059): null when it pays for itself. For an Attached
   * Organization, `organizationId` is its Paying Organization's id when the
   * caller is a member of that one too — so it is in this same list — and
   * null when they are not: "Paid by another Organization", never which.
   */
  paidBy: { organizationId: string | null } | null;
}

/** `GET /organizations/members`, which better-auth answers with the user joined. */
export interface MemberWithUser extends Member {
  user: {
    id: string;
    /** better-auth's `name` — the `firstName` column. */
    name: string;
    /**
     * Cloudgate's column, not the plugin's: better-auth joins only the four
     * fields around it, so `OrganizationsService.listMembers` adds this one.
     * Empty rather than absent when it was never set.
     */
    lastName: string;
    email: string;
    image: string | null;
  };
  /**
   * Whether this member's account is deactivated — `null` when it is not.
   * Decided by the backend with the same rule sign-in refuses on
   * (`memberDeactivation` in `organizations.service.ts`), so an elapsed ban
   * already reads `null` here.
   */
  deactivation: MemberDeactivation | null;
}

/** A member who cannot sign in, and why. */
export interface MemberDeactivation {
  /**
   * The identity provider did it over SCIM (`active: false`). Nothing in the
   * console reverses that; the directory does, by sending `active: true`.
   */
  byDirectory: boolean;
  /** The stored ban reason, verbatim — `"Deactivated via SCIM"` when `byDirectory`. */
  reason: string | null;
  /** When the ban ends by itself; `null` for one that does not. */
  expiresAt: string | null;
}

export interface MemberList {
  members: MemberWithUser[];
  total: number;
}

/**
 * The body of `PATCH /organizations/members/:id/entitlements`.
 *
 * **All three keys are required on our side, and the route's are all optional.**
 * That is not an oversight in one of the two: the route replaces *per column*,
 * so an absent key means "leave this column alone" — a real thing for a caller
 * editing one column by hand, and a thing no console screen ever wants to say.
 * Requiring them here means the client cannot express a partial write by
 * accident, and a `[]` that clears a column has to be written down rather than
 * arrived at by leaving a key out.
 *
 * The keys are the schema column names rather than prettier product words
 * because `Member` above already types the row with them, so the console reads
 * and writes one vocabulary (the DTO says the same, from the other side).
 */
export interface MemberEntitlements {
  accessedProjects: string[];
  accessedEnvironments: string[];
  accessedServices: string[];
}

export interface Invitation {
  id: string;
  organizationId: string;
  email: string;
  role: string | null;
  status: string;
  teamId: string | null;
  expiresAt: string;
  inviterId: string;
  createdAt: string;
}

export interface Team {
  id: string;
  name: string;
  organizationId: string;
  createdAt: string;
  updatedAt: string | null;
}

export interface TeamMember {
  id: string;
  teamId: string;
  userId: string;
  createdAt: string;
}

/**
 * `GET /organizations/creation` — whether `POST /organizations` would accept
 * this person now, and why not, so "New organization" is greyed out with
 * the reason before anyone clicks (`OrganizationsService.creation`). The
 * backend asks the questions the create asks, in the same order.
 */
export interface OrganizationCreation {
  allowed: boolean;
  /** The refusal's own sentence; `null` when allowed. */
  reason: string | null;
  /** `ORGANIZATION_LIMIT` for the one-Organization limit (ADR-0059). */
  code: string | null;
  /**
   * The reader is an owner or admin of the Instance organization, who can add
   * the license that lifts the Self-hosted limit.
   */
  licenseHint: boolean;
  /**
   * A Self-hosted instance holding more than one Organization without the
   * Instance organization's license, told to the open Organization's owners and
   * admins; `count` only to the Instance organization's. `null` otherwise.
   */
  overLimit: { count: number | null } | null;
  /**
   * Hosted: how many Organizations that pay for themselves the reader owns, of
   * the one a person may (ADR-0059). Attached ones and the Instance
   * organization are not counted. `null` on a Self-hosted instance.
   */
  ownedPayingForThemselves: { count: number; of: number } | null;
  /**
   * Hosted, when refused, for the open Organization's owners and admins only:
   * "Add an Organization to <name>'s plan" when it can pay for one, otherwise
   * "See plans". `null` for everyone else.
   */
  planHint:
    | { kind: "add-to-plan"; organizationName: string }
    | { kind: "see-plans" }
    | null;
}

export interface UpdateOrganizationInput {
  name: string;
  logo?: string;
}

export interface CreateOrganizationInput extends UpdateOrganizationInput {
  /**
   * Who pays for it (ADR-0059): `itself`, the default, or
   * `active-organization` — "Add an Organization to this plan", which makes it
   * an Attached Organization of the active one. Hosted only; refused with
   * `ORGANIZATION_LIMIT` and the reason when the active Organization cannot
   * pay for one.
   */
  paidBy?: "itself" | "active-organization";
}

/**
 * `GET /organizations/invitations/:id/state` — what became of one invitation,
 * as one code. better-auth's own read refuses every closed invitation with the
 * same `INVITATION_NOT_FOUND`; this is the route that tells them apart.
 *
 * `INVITATION_NOT_FOUND` here means there is no row: Revoke and Delete on the
 * Members screen hard-delete it, so that is what a withdrawn invitation reads
 * as. `INVITATION_WITHDRAWN` is better-auth's `canceled` status, which only its
 * own cancel route writes.
 */
export interface InvitationState {
  id: string;
  code:
    | "INVITATION_ALREADY_ACCEPTED"
    | "INVITATION_REJECTED"
    | "INVITATION_WITHDRAWN"
    | "INVITATION_EXPIRED"
    | "INVITATION_PENDING"
    | "INVITATION_NOT_OPEN"
    | "INVITATION_NOT_FOUND";
  status: string | null;
  expiresAt: string | null;
}

/**
 * `admin`, `member`, or a custom role this Organization has defined.
 * Owner is not delegable, and the route refuses it.
 */
export interface InviteMemberInput {
  email: string;
  role: string;
  teamId?: string;
}

export const organizationsApi = {
  list: () => api.get<OrganizationMembership[]>("/organizations"),

  /** The Organization the session is currently pointed at. */
  active: () => api.get<Organization>("/organizations/active"),

  findOne: (organizationId: string) =>
    api.get<Organization>(`/organizations/${organizationId}`),

  create: (input: CreateOrganizationInput) =>
    api.post<Organization>("/organizations", input),

  /** Whether `create` would be accepted now, and why not. */
  creation: () => api.get<OrganizationCreation>("/organizations/creation"),

  update: (organizationId: string, input: UpdateOrganizationInput) =>
    api.patch<Organization>(`/organizations/${organizationId}`, input),

  remove: (organizationId: string) =>
    api.delete<unknown>(`/organizations/${organizationId}`),

  /** Which Organization the caller lands in when they next sign in. */
  setDefault: (organizationId: string) =>
    api.post<unknown>(`/organizations/${organizationId}/set-default`),

  listMembers: () => api.get<MemberList>("/organizations/members"),

  updateMemberRole: (memberId: string, role: string) =>
    api.patch<Member>(`/organizations/members/${memberId}`, { role }),

  /**
   * The row-level grants that sit beside the role — what this person may reach
   * at all.
   *
   * Owner/admin only, and refused for a licensed custom role holding
   * `member: update` as well: `assertMemberRole` is the real gate, not the
   * `@RequirePermission` in front of it. A member id from another Organization
   * is `404 Member not found` rather than a refusal that confirms it exists.
   *
   * **Every id must still resolve.** `assertGrantsResolve` refuses the whole
   * PATCH with `404 Project not found: <id>` if one does not, and a `member`
   * row keeps ids for deleted rows — see `lib/auth/access-grants.ts`,
   * which is where the console reconciles that with the replace semantics.
   */
  updateMemberEntitlements: (memberId: string, grants: MemberEntitlements) =>
    api.patch<Member>(
      `/organizations/members/${memberId}/entitlements`,
      grants,
    ),

  removeMember: (memberId: string) =>
    api.delete<unknown>(`/organizations/members/${memberId}`),

  listInvitations: () => api.get<Invitation[]>("/organizations/invitations"),

  invite: (input: InviteMemberInput) =>
    api.post<Invitation>("/organizations/invitations", input),

  /**
   * Readable by the invitation's recipient, who is not a member yet — the one
   * invitation route that is not scoped by membership. Anyone else is refused
   * `403 YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION`.
   */
  invitationState: (invitationId: string) =>
    api.get<InvitationState>(
      `/organizations/invitations/${invitationId}/state`,
    ),

  acceptInvitation: (invitationId: string) =>
    api.post<unknown>(`/organizations/invitations/${invitationId}/accept`),

  removeInvitation: (invitationId: string) =>
    api.delete<unknown>(`/organizations/invitations/${invitationId}`),

  listTeams: () => api.get<Team[]>("/organizations/teams"),

  createTeam: (name: string) =>
    api.post<Team>("/organizations/teams", { name }),

  updateTeam: (teamId: string, name: string) =>
    api.patch<Team>(`/organizations/teams/${teamId}`, { name }),

  removeTeam: (teamId: string) =>
    api.delete<unknown>(`/organizations/teams/${teamId}`),

  listTeamMembers: (teamId: string) =>
    api.get<TeamMember[]>(`/organizations/teams/${teamId}/members`),

  addTeamMember: (teamId: string, userId: string) =>
    api.post<TeamMember>(`/organizations/teams/${teamId}/members`, { userId }),

  /**
   * Take somebody off a team, leaving both the team and their membership of the
   * Organization alone.
   *
   * **This route answers better-auth, not this repo's exception vocabulary**, and
   * a screen has to be built for that. `removeTeamMember` is delegated straight to
   * the plugin, so its refusals come back as **400** where every hand-rolled route
   * here would answer 403 or 404:
   *
   * - a team of another Organization — `400 Team not found`, not a 404. The team is
   *   scoped to the session's active Organization, so from elsewhere it does not
   *   exist, and the status does not say "absent" the way the rest of the API does.
   * - somebody who is not on the team — `400 User is not a member of the team`.
   * - **a user who has already left the Organization** —
   *   `400 User is not a member of the organization`, and this one is not an edge
   *   case. Removing a member does not delete their `team_member` rows, so a team
   *   keeps a roster entry for someone who is gone, and **this route cannot clear
   *   it**: the check that refuses is the plugin's own. Deleting the team is the
   *   only way to be rid of that row.
   *
   * A plain member gets 403 and an anonymous caller 401, which are ordinary.
   */
  removeTeamMember: (teamId: string, userId: string) =>
    api.delete<unknown>(`/organizations/teams/${teamId}/members/${userId}`),
};
