import { useState } from "react";

import { Dash } from "@/components/console/dash";
import { Picker } from "@/components/console/picker";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { Team } from "@/lib/api/endpoints/organizations";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { personName } from "@/lib/format/person";
import { cn } from "@/lib/utils";

import { splitMembers } from "./member-kinds";
import {
  useAddTeamMember,
  useMembers,
  useRemoveTeamMember,
  useTeamMembers,
} from "./use-members";

/**
 * One team, and its roster once you ask for it.
 *
 * **The roster is fetched only while the row is open**, which is the rail's rule
 * for group children applied one level down: a listing of five teams would
 * otherwise be six requests before anybody has expressed interest in any of
 * them.
 *
 * **Taking somebody off a team works now**
 * —
 * `DELETE /organizations/teams/:id/members/:userId`. It is a row control rather
 * than a dialog: it undoes an add, it takes nothing away but the team membership,
 * and re-adding is the picker directly below. A confirmation for that is the habit
 * that makes the irreversible confirmations stop working.
 *
 * **That reasoning covers the roster's Remove and not this row's Delete**
 * which is why
 * `onDelete` now only *asks* for the deletion: deleting the team cascades
 * `team_member` and takes the whole roster with it, so there is no picker below
 * to undo it with. `DeleteTeamModal` is the dialog, and `TeamsCard` owns it —
 * this row has no business deciding either way, which is what handing it a
 * ready-made `mutateAsync` used to make it do.
 *
 * **The roster's two kinds of row are the interesting part, and only one of them
 * can be removed.** The route answers `team_member` rows — `userId` and nothing
 * else — so names are joined against the member list this screen already has, and
 * a row with no match is a real state: removing somebody from the Organization
 * does **not** delete their `team_member` rows. Those orphans cannot be cleared
 * here, because better-auth refuses with `400 User is not a member of the
 * organization` before it looks at the team. So the control is not offered on
 * them, and the row says what it is and what the way out is — rather than a button
 * that fails every time it is pressed.
 */
export function TeamRow({
  team,
  onRename,
  onDelete,
}: {
  team: Team;
  onRename: () => void;
  /** Asks for the team to be deleted; the confirmation is the card's. */
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState("");
  const roster = useTeamMembers(open ? team.id : null);
  const members = useMembers();
  const addMember = useAddTeamMember();
  const removeMember = useRemoveTeamMember();
  // better-auth's checks on the four team routes this row reaches:
  // rename `team: ['update']`, delete `team: ['delete']`, and — its own
  // choice, not ours — adding to a roster `member: ['update']` and taking
  // somebody off it `member: ['delete']`.
  const canRename = usePermission({ team: ["update"] });
  const canDelete = usePermission({ team: ["delete"] });
  const canAdd = usePermission({ member: ["update"] });
  const canTakeOff = usePermission({ member: ["delete"] });

  const inTeam = new Set((roster.data ?? []).map((row) => row.userId));
  // People only: an Agent is a member row too, but not one a team is for,
  // and its label here would be its synthetic address.
  const candidates = splitMembers(members.data?.members ?? []).people.filter(
    (row) => !inTeam.has(row.userId),
  );

  return (
    <li className="border-b border-line last:border-b-0">
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left text-body font-medium text-tx"
        >
          <Icon
            name="chevR"
            size={15}
            className={cn(
              "flex-none text-tx-3 transition-transform duration-150 ease-out-strong",
              open && "rotate-90",
            )}
          />
          <span className="min-w-0 truncate">{team.name}</span>
        </button>
        <Button
          type="button"
          size="xs"
          disabled={!canRename.allowed}
          title={canRename.allowed ? undefined : RENAME_REFUSAL}
          onClick={() => canRename.allowed && onRename()}
        >
          Rename
        </Button>
        <Button
          type="button"
          size="xs"
          variant="dngr"
          disabled={!canDelete.allowed}
          title={canDelete.allowed ? undefined : DELETE_REFUSAL}
          onClick={() => canDelete.allowed && onDelete()}
        >
          Delete
        </Button>
      </div>

      {open ? (
        <div className="animate-fade border-t border-line bg-panel-2 px-4 py-3">
          {roster.isPending ? (
            <div className="grid gap-2" aria-busy="true">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-4 w-36" />
            </div>
          ) : roster.error ? (
            <p className="text-meta text-tx-2">
              Cloudgate could not read who is in this team.
            </p>
          ) : (roster.data ?? []).length === 0 ? (
            <p className="text-meta text-tx-2">Nobody is in this team yet.</p>
          ) : (
            <ul className="grid gap-1.5">
              {(roster.data ?? []).map((row) => {
                const person = (members.data?.members ?? []).find(
                  (member) => member.userId === row.userId,
                );
                const name = person ? personName(person.user) : null;
                return (
                  <li
                    key={row.id}
                    className="flex flex-wrap items-baseline gap-x-2 text-ui text-tx"
                  >
                    <span>
                      {name ?? (
                        <span className="font-mono text-tx-2">
                          {row.userId}
                        </span>
                      )}
                    </span>
                    {person ? (
                      <span className="text-meta text-tx-3">
                        {person.user.email}
                      </span>
                    ) : (
                      <span className="text-meta text-tx-3">
                        no longer a member of this Organization, so this row can
                        only be cleared by deleting the team
                      </span>
                    )}
                    {/* Only a row whose user is still in the Organization can be
                        removed — better-auth checks that before it checks the
                        team, so on an orphan the control could only ever 400.
                        See the note at the top of this file. */}
                    {person ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="dngr"
                        className="ml-auto"
                        disabled={
                          !canTakeOff.allowed || removeMember.isPending
                        }
                        title={
                          canTakeOff.allowed ? undefined : TAKE_OFF_REFUSAL
                        }
                        onClick={async () => {
                          if (!canTakeOff.allowed) return;
                          try {
                            await removeMember.mutateAsync({
                              teamId: team.id,
                              userId: row.userId,
                            });
                            toast.done(`Took ${name} off ${team.name}.`, {
                              description:
                                "They are still a member of this Organization.",
                            });
                          } catch (error) {
                            toast.error(error);
                          }
                        }}
                      >
                        Remove
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-1 basis-56">
              <label
                htmlFor={`add-to-${team.id}`}
                className="mb-1 block text-meta font-medium text-tx-3"
              >
                Add a member
              </label>
              {candidates.length === 0 ? (
                <p className="text-meta text-tx-2">
                  {members.data
                    ? "Everyone in this Organization is already in this team."
                    : <Dash word="Unknown" />}
                </p>
              ) : (
                <Picker
                  id={`add-to-${team.id}`}
                  value={adding}
                  onValueChange={setAdding}
                  placeholder="Choose someone"
                  options={candidates.map((row) => ({
                    value: row.userId,
                    label: personName(row.user),
                    detail: row.user.email,
                  }))}
                />
              )}
            </div>
            <Button
              type="button"
              size="sm"
              disabled={
                !canAdd.allowed || adding === "" || addMember.isPending
              }
              title={canAdd.allowed ? undefined : ADD_REFUSAL}
              aria-busy={addMember.isPending || undefined}
              onClick={async () => {
                if (!canAdd.allowed) return;
                try {
                  await addMember.mutateAsync({
                    teamId: team.id,
                    userId: adding,
                  });
                  setAdding("");
                  toast.done(`Added to ${team.name}.`);
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Add
            </Button>
          </div>

          <p className="mt-2.5 text-meta text-tx-3">
            Adding somebody to a team and taking them off it change the team only.
            Neither touches their membership of this Organization, and neither
            changes what they can reach — a team is a grouping here, not a role.
          </p>
        </div>
      ) : null}
    </li>
  );
}

const RENAME_REFUSAL = roleRefusal("rename a team");
const DELETE_REFUSAL = roleRefusal("delete a team");
const ADD_REFUSAL = roleRefusal("add someone to a team");
const TAKE_OFF_REFUSAL = roleRefusal("take someone off a team");
