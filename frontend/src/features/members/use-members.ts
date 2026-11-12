import { useMutation, useQuery } from "@tanstack/react-query";

import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import {
  organizationsApi,
  type InviteMemberInput,
} from "@/lib/api/endpoints/organizations";
import { rolesApi } from "@/lib/api/endpoints/roles";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * Membership of the active Organization: who is in it, who has been asked, and
 * what a role means.
 *
 * Every read here is **scoped by the session's active Organization on the server
 * side**, not by an id in the URL — `listMembers` goes through better-auth's own
 * `listMembers`, and `listInvitations` resolves the org from the session (or the
 * caller's default membership, for an api-key session). So the query key carries
 * `organizationId` to keep two tenants' answers apart in the cache, while the
 * request itself carries nothing: switching Organization changes the answer *and*
 * the key, which is the arrangement `keys.ts` is built around.
 *
 * `invalidate.membership()` is what every mutation here calls, and it widens
 * further than it looks — see the note on that method.
 */

export function useMembers() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.organization.members(organizationId),
    queryFn: organizationsApi.listMembers,
    enabled: organizationId !== null,
  });
}

export function useInvitations() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.organization.invitations(organizationId),
    queryFn: organizationsApi.listInvitations,
    enabled: organizationId !== null,
  });
}

export function useTeams() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.organization.teams(organizationId),
    queryFn: organizationsApi.listTeams,
    enabled: organizationId !== null,
  });
}

export function useTeamMembers(teamId: string | null) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.organization.teamMembers(organizationId, teamId ?? ""),
    queryFn: () => organizationsApi.listTeamMembers(teamId as string),
    enabled: organizationId !== null && teamId !== null,
  });
}

/**
 * The Organization's custom roles.
 *
 * Reading is open to any member; creating one needs an enterprise licence
 * (`CustomRolesService.ensureEnterprise`), which is F18's screen. So this is an
 * empty array on an instance that was never licensed — a true answer rather than
 * a refusal, and the role picker simply offers the two static roles.
 *
 * **It is not empty once a licence lapses.** Nothing deletes the
 * `organization_role` rows, so this keeps answering with roles that no longer
 * resolve, and assigning one is now refused
 * `ChangeRoleModal`
 * is where that is sorted out, by pairing this with `useLicenseStatus`.
 */
export function useCustomRoles() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.roles.list(organizationId),
    queryFn: rolesApi.list,
    enabled: organizationId !== null,
  });
}

export function useInviteMember() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: InviteMemberInput) => organizationsApi.invite(input),
    onSettled: () => invalidate.membership(),
  });
}

export function useRemoveInvitation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (invitationId: string) =>
      organizationsApi.removeInvitation(invitationId),
    onSettled: () => invalidate.membership(),
  });
}

export function useRemoveMember() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (memberId: string) => organizationsApi.removeMember(memberId),
    onSettled: () => invalidate.membership(),
  });
}

export function useCreateTeam() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (name: string) => organizationsApi.createTeam(name),
    onSettled: () => invalidate.membership(),
  });
}

export function useRenameTeam() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ teamId, name }: { teamId: string; name: string }) =>
      organizationsApi.updateTeam(teamId, name),
    onSettled: () => invalidate.membership(),
  });
}

export function useRemoveTeam() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (teamId: string) => organizationsApi.removeTeam(teamId),
    onSettled: () => invalidate.membership(),
  });
}

export function useAddTeamMember() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      organizationsApi.addTeamMember(teamId, userId),
    onSettled: () => invalidate.membership(),
  });
}

/**
 * Take somebody off a team.
 *
 * `onSettled` rather than `onSuccess`, and here that is doing real work rather
 * than being cautious: the refusal this route gives most often —
 * `400 User is not a member of the organization` — happens on a roster row whose
 * user has already left, which is a row the *member list* also disagrees with.
 * Refetching on a failure is what puts the two back in step. See
 * `organizationsApi.removeTeamMember` for the rest of the 400s.
 */
export function useRemoveTeamMember() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({ teamId, userId }: { teamId: string; userId: string }) =>
      organizationsApi.removeTeamMember(teamId, userId),
    onSettled: () => invalidate.membership(),
  });
}
