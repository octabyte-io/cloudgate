import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Team } from "@/lib/api/endpoints/organizations";

import { useRemoveTeam, useTeamMembers } from "./use-members";

/**
 * Delete a team, having counted who is in it.
 *
 * **Delete used to run from the row's `onClick`, on one press**, and it takes
 * the roster with it: `team_member.team_id` is `ON DELETE CASCADE`, so deleting
 * a team of eight deletes eight rows nothing keeps a copy of, and rebuilding it
 * means adding every one of them back through the picker one at a time. That is
 * why the count is the body of this dialog rather than a nicety — "delete
 * `ui-team-renamed`" and "delete `ui-team-renamed` **and its two members**" are
 * different decisions, and the row cannot tell them apart because the roster is
 * only fetched when the row is expanded.
 *
 * **So this dialog asks for the roster itself.** It is the same query key the
 * expanded row uses, so opening a team that is already open costs nothing, and
 * a count that has not arrived is said to be missing rather than rendered as
 * zero — "delete a team with nobody in it" is exactly the wrong thing to imply
 * while the answer is in flight.
 *
 * **A plain confirmation and not a typed name**, on `DeleteRoleModal`'s
 * reasoning: what is lost is a grouping that grants nothing — no permission
 * anywhere reads team membership (`TeamsCard` says so on the card) — and
 * reserving the typed name for the things whose loss is unbounded is what keeps
 * it meaningful.
 *
 * Nobody loses their membership of the Organization: the cascade reaches
 * `team_member` and stops there.
 */
export function DeleteTeamModal({
  team,
  open,
  onOpenChange,
}: {
  team: Team;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const removeTeam = useRemoveTeam();
  const roster = useTeamMembers(open ? team.id : null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const count = roster.data?.length;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Delete ${team.name}?`}
        description="The team goes; everybody in it stays a member of this Organization."
      />
      <Modal.Body>
        <p className="text-body wrap-anywhere text-tx-2">
          <strong className="font-medium text-tx">{team.name}</strong>{" "}
          {count === undefined ? (
            <>
              and its roster are deleted together — Cloudgate could not count who
              is in it just now, so check the row before you do this.
            </>
          ) : count === 0 ? (
            <>is deleted. Nobody is in it, so nothing else goes with it.</>
          ) : (
            <>
              and its {count} {count === 1 ? "member" : "members"}{" "}
              are deleted together: the team&rsquo;s roster goes with the team,
              and nothing keeps a copy of it. Making the team again means adding
              each of them back by hand.
            </>
          )}
        </p>
        <p className="mt-2.5 text-body text-tx-2">
          Nobody is removed from this Organization and nothing they can reach
          changes — a team is a grouping here, not a role.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={removeTeam.isPending}
          aria-busy={removeTeam.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await removeTeam.mutateAsync(team.id);
              toast.done(`${team.name} is deleted.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Delete the team
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
