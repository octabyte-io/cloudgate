import { useState } from "react";

import { Card } from "@/components/console/card";
import { EmptyState } from "@/components/console/empty-state";
import { Button } from "@/components/ui/button";
import type { Team } from "@/lib/api/endpoints/organizations";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { DeleteTeamModal } from "./delete-team-modal";
import { TeamRow } from "./team-row";
import { TeamFormModal } from "./team-form-modal";
import { useTeams } from "./use-members";

/**
 * Teams — a grouping inside the Organization, and honestly not much more than
 * that yet.
 *
 * **The card says what a team currently does, because the answer is "very
 * little", and a screen that implied otherwise would be the misleading part.**
 * `team` and `team_member` are better-auth's tables, an invitation can carry a
 * `teamId`, and `member.accessedProjects` / `accessedServices` /
 * `accessedEnvironments` are the columns that actually decide what a
 * non-privileged role can see — and those are **per member**, not per team.
 * Nothing in `rbac/` reads team membership. So a team is a label you can group
 * people under and invite into; it grants nothing.
 *
 * **Delete asks first**,
 * because it does not only delete the team: `team_member` cascades with it, so
 * the roster goes and nothing keeps a copy. `DeleteTeamModal` counts it.
 *
 * Each team is its own expandable row rather than a table, because the useful
 * thing about a team is *who is in it*, and that is a second request per team
 * (`GET /organizations/teams/:id/members`). Fetching all of them to fill a
 * "Members" column would be F08's 2N+1 again, for a column nobody scans.
 */
export function TeamsCard() {
  const teams = useTeams();
  const [editing, setEditing] = useState<Team | null>(null);
  /** The team a confirmation is open for — see `DeleteTeamModal`. */
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [creating, setCreating] = useState(false);
  // better-auth's own check on `POST /organizations/teams` is
  // `team: ['create']`, which a custom role can never hold — the roles
  // builder offers no `team` row. `TeamRow` reads the other three.
  const canCreate = usePermission({ team: ["create"] });

  const arrival = useArrival(teams.isPending);
  if (teams.isPending) return <SectionPending title="Teams" rows={2} />;
  if (teams.error) {
    return (
      <SectionFailed title="Teams" error={teams.error}>
        Teams are read through better-auth&rsquo;s organization plugin, scoped to
        the session&rsquo;s Organization.
      </SectionFailed>
    );
  }

  const rows = teams.data ?? [];

  return (
    <Card className={arrival}>
      <Card.Header
        title="Teams"
        sub="A way to group people. It does not change what they can do."
        headingLevel={2}
        actions={
          <Button
            size="sm"
            disabled={!canCreate.allowed}
            title={canCreate.allowed ? undefined : TEAM_CREATE_REFUSAL}
            onClick={() => canCreate.allowed && setCreating(true)}
          >
            Create a team
          </Button>
        }
      />
      <Card.Body className={rows.length === 0 ? undefined : "p-0"}>
        {rows.length === 0 ? (
          <EmptyState
            icon="users"
            title="No teams yet"
            action={
              <Button
                size="sm"
                disabled={!canCreate.allowed}
                title={canCreate.allowed ? undefined : TEAM_CREATE_REFUSAL}
                onClick={() => canCreate.allowed && setCreating(true)}
              >
                Create a team
              </Button>
            }
          >
            Teams group members and can be named when you invite somebody.
            Permissions come from a person&rsquo;s role, not from their team.
          </EmptyState>
        ) : (
          <ul>
            {rows.map((team) => (
              <TeamRow
                key={team.id}
                team={team}
                onRename={() => setEditing(team)}
                onDelete={() => setDeleting(team)}
              />
            ))}
          </ul>
        )}
      </Card.Body>

      {creating ? (
        <TeamFormModal key="create" open onOpenChange={setCreating} />
      ) : null}
      {editing ? (
        <TeamFormModal
          key={editing.id}
          team={editing}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setEditing(null);
          }}
        />
      ) : null}
      {deleting ? (
        <DeleteTeamModal
          key={deleting.id}
          team={deleting}
          open
          onOpenChange={(next: boolean) => {
            if (!next) setDeleting(null);
          }}
        />
      ) : null}
    </Card>
  );
}

const TEAM_CREATE_REFUSAL = roleRefusal("create a team");
