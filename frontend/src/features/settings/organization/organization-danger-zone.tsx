import { DangerZone } from "@/components/console/danger-zone";
import type { OrganizationMembership } from "@/lib/api/endpoints/organizations";
import { unwrap } from "@/lib/auth/auth-error";
import { organization } from "@/lib/auth/client";
import { useServers } from "@/lib/api/use-servers";
import { useDeleteOrganization } from "@/lib/api/use-organizations";
import { useProjects } from "@/features/project/use-projects";

/**
 * Destroying the Organization you are in, having named what goes with it.
 *
 * It is offered for the **active** Organization only, which is a design decision
 * rather than a limitation of the route: `DELETE /organizations/:id` takes any id
 * you own, but the counts below are scoped to the session's active Organization on
 * the server side. Naming "everything in Second Organization" without being able to
 * say what that is would be exactly the confident-sounding emptiness F07's
 * `CountTile` defect was about.
 */
export function OrganizationDangerZone({
  active,
  rows,
}: {
  active: OrganizationMembership;
  /** Every membership, for the switch that has to happen before the delete. */
  rows: readonly OrganizationMembership[];
}) {
  const remove = useDeleteOrganization();
  const projects = useProjects();
  const servers = useServers();

  const ownedCount = rows.filter(
    (row) => row.ownerId === row.member.userId,
  ).length;

  return (
    <DangerZone
      sub={`This is about ${active.name}, the Organization you are in.`}
      actions={[
        {
          id: "delete-organization",
          title: `Delete ${active.name}`,
          description:
            "Everything in it goes: Projects, Environments, services, Servers, members, integrations and settings.",
          button: "Delete Organization",
          confirm: { value: active.name, noun: "Organization's name" },
          unavailable:
            ownedCount <= 1
              ? "You have to own at least one Organization, and this is your only one."
              : undefined,
          consequences: (
            <>
              <p>
                Deleting <strong className="font-medium">{active.name}</strong>{" "}
                destroys{" "}
                <strong className="font-medium">
                  {describe(projects.data?.length, "Project")}
                </strong>{" "}
                and{" "}
                <strong className="font-medium">
                  {describe(servers.data?.length, "Server")}
                </strong>
                , with every Environment, Deployment, variable, domain,
                certificate, integration and member of this Organization.
              </p>
              <p className="mt-2">
                Cloudgate deletes its own rows. It does not go near the machines:
                containers already running on a Server keep running, unmanaged,
                and nothing here will be able to reach them again.
              </p>
            </>
          ),
          /**
           * **Move the session before deleting the row, not after.**
           *
           * Found by driving it: deleting the Organization you are in and
           * then reloading leaves `session.activeOrganizationId` naming a
           * row that no longer exists. Every backend read resolves its
           * permission context from that id, `findMember` finds nothing, and
           * the console comes back up with a **403 on every card** —
           * rendered, correctly but uselessly, as "your role in this
           * organization does not allow this". The masthead had no name to
           * show either.
           *
           * So the switch happens first, while there is still a session that
           * can perform it, and only then is the row destroyed. There is
           * always somewhere to go: `OrganizationsService.delete` refuses
           * unless the caller owns at least one *other* Organization.
           */
          run: async () => {
            const elsewhere = rows.find((row) => row.id !== active.id);
            if (elsewhere) {
              // `unwrap`: a refused switch must stop the delete here, or the
              // row goes with the session still naming it — the state this
              // ordering exists to avoid.
              await unwrap(
                organization.setActive({ organizationId: elsewhere.id }),
              );
            }
            await remove.mutateAsync(active.id);
          },
          done: `${active.name} is deleted.`,
          onDone: () => {
            // A full load rather than a navigation: the auth client holds
            // the session in a module-level store, and every cached row in
            // this tab belongs to a tenant that has just stopped existing.
            // This is F06's sign-out reasoning, for the same reason.
            window.location.assign("/");
          },
        },
      ]}
    />
  );
}

/**
 * "3 Projects", or "an unknown number of Projects" while the count is in flight.
 *
 * F07's confident-`0` defect, in the one place it would cost the most: a delete
 * dialog that says "0 Projects" because a request has not landed is telling
 * somebody the Organization is empty at the exact moment they decide to destroy
 * it.
 */
function describe(count: number | undefined, noun: string): string {
  if (count === undefined) return `an unknown number of ${noun}s`;
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}
