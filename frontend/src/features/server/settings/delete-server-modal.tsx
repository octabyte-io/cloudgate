import { useRouter } from "next/navigation";

import { ConfirmDeleteModal } from "@/components/console/confirm-delete-modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import type { Server } from "@/lib/api/endpoints/servers";

import { useSwarmServices } from "../docker/use-server-docker";
import { useDeleteServer } from "../use-server";

/**
 * Delete a Server, having named what is running on it.
 *
 * The brief's instruction — *"deleting a server with running services must name them
 * first"* — has one honest source and it is not the one you would reach for.
 * Cloudgate's own record cannot answer *which services are on this Server*: an
 * Environment names its services and each carries a `serverId`
 * but the index runs the
 * other way, so answering it here means reading every Environment in the
 * Organization to open one dialog. **Docker can answer directly**: `docker service
 * ls` on the host names every Swarm service running there. So this dialog asks the
 * machine.
 *
 * That answer has a limit and the dialog states it rather than presenting the list as
 * complete: it is Docker's names, not Cloudgate's, so it cannot say which Project or
 * Environment each one belongs to — and a host that will not answer (a worker, or one
 * that is already unreachable) gets a sentence saying the question could not be asked,
 * which is different from "nothing is running".
 *
 * **What deleting actually does is the other thing worth saying.** It removes the row
 * and nothing else: no SSH, no `docker service rm`, no cleanup. Every container on that
 * machine keeps running, with nothing managing it and no way to reach it from here.
 * That is a *more* alarming outcome than "your services are destroyed", so it is the
 * first thing in the dialog rather than a footnote.
 *
 * **And it can now refuse**.
 * Until the guard, `ServersService.remove` was one unguarded `DELETE` on `server` while
 * every service table's `serverId` was `onDelete: 'cascade'` — so the sentence above was
 * true of the *machine* and false of the *records*: deleting a Server carrying services
 * silently deleted Cloudgate's row for each Application, Compose stack and database on
 * it, and the dialog's own advice ("stop what you want stopped first") became
 * unfollowable the moment you ignored it, because nothing was left saying which Project
 * those containers had belonged to. The backend refuses now and names them; the second
 * paragraph below says so before the operator types anything, and `ConfirmDeleteModal`
 * renders the 409's own sentence — which lists the services — in place.
 *
 * The two lists are **not the same question** and the dialog must not let them read as
 * one: Docker's list is what is *running on the host*, the refusal is about what
 * *Cloudgate has a record of*. A machine can be busy with neither, or with both.
 *
 * The typed confirmation is here for the same reason F11 put one on Rebuild: the
 * consequence is not what the word implies. **F19 rebuilt it on `ConfirmDeleteModal`**,
 * because this dialog was the one that had drifted from the other four on every part of
 * that confirmation — see the note there. The one that mattered: it never cleared the
 * typed name, so reopening this dialog after a cancel armed the delete before you had
 * read a word of it.
 *
 * **A Bought Server is the one Server Delete does touch** (ADR-0071): Cloudgate
 * deletes the machine it bought, with its data, its backups and its extra storage,
 * and there is no "keep the machine". So for one the first paragraph says the
 * opposite of the above, plainly, that it cannot be undone; the Services rule and
 * Docker's list stay as they are.
 */
export function DeleteServerModal({
  server,
  open,
  onOpenChange,
}: {
  server: Server;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const remove = useDeleteServer(server.serverId);
  const services = useSwarmServices(server.serverId);

  const rows = services.data;
  const bought = Boolean(server.boughtServer);

  return (
    <ConfirmDeleteModal
      open={open}
      onOpenChange={onOpenChange}
      title={`Delete ${server.name}?`}
      description={
        bought
          ? "Its machine is deleted, with its data and backups. This cannot be undone."
          : "Cloudgate forgets the machine. It does not touch it."
      }
      confirmWord={server.name}
      mismatch="That does not match the Server's name."
      button="Delete this Server"
      onConfirm={async () => {
        await remove.mutateAsync();
        if (bought) {
          toast.done(`Server ${server.name} deleted.`, {
            description:
              "Its machine, data and backups are deleted. The unused part of the month is credited on your next invoice.",
          });
        } else {
          toast.done(`Server ${server.name} removed from Cloudgate.`, {
            description:
              "The machine is untouched. Anything running on it is still running.",
          });
        }
        onOpenChange(false);
        router.push("/servers");
      }}
    >
      {/* `{" "}` after the closing `</strong>`, not a bare newline: a JSXText
          node containing a newline loses its leading whitespace, so this read
          "on localhostkeeps running" on a real screen. F10's rule 3, and this
          codebase had paid for it five times when the convention was turned
          into `cloudgate/jsx-inline-element-spacing`.

          The sixth through thirteenth sites move the blame: not one of those
          eight sources is missing a space. Measured against the shipped bundle
          across all 83 comparable sites in the console, the build itself drops
          a text node's leading space when that node also carries an HTML entity
          — 77 without one keep it, 6 with one lose it, no exceptions either way;
          the remaining two were on `/dev/rows`, which that sweep did not reach
          and the rule did. So this is the transform and not the author, which is
          why the paragraph below now guards *both* sides of `{server.name}` even
          though the second space was already there in the source. */}
      {bought ? (
        <p className="text-body text-tx">
          This deletes the machine at{" "}
          <strong className="font-medium">{server.ipAddress}</strong> with
          everything on it: its disk, every backup of it and its extra storage.
          They are gone for good, and nobody can bring them back, so copy out
          anything you want to keep first. Its address is released too. The
          unused part of this month is credited on your next invoice.
        </p>
      ) : (
        <p className="text-body text-tx">
          Nothing is stopped and nothing is cleaned up. Every container and
          every Swarm service on{" "}
          <strong className="font-medium">{server.ipAddress}</strong>{" "}
          keeps
          running after this — with nothing managing it, and no way to reach it
          from this console. Stop what you want stopped first, on the Docker
          &amp; Swarm tab.
        </p>
      )}

      <p className="text-body text-tx">
        What Cloudgate will not do is forget a machine it is still tracking
        services on. If any Application, Compose stack or database names{" "}
        <strong className="font-medium">{server.name}</strong>{" "}
        as its Server,
        this refuses and lists them — deleting the row would take
        Cloudgate&rsquo;s record of every one of them with it, and then nothing
        would say which Project those containers belonged to. It refuses for the
        configuration that names this Server too — a stored certificate, a
        scheduled job, or its forward-auth rule — which is not a Service and is
        listed separately in the refusal. Move them to another Server, or delete
        them, first. That is a different list from the one below: this is what
        Cloudgate has a record of, that is what Docker has running.
      </p>

      <div className="rounded-lg border border-line bg-panel-2 p-3">
        <p className="text-meta text-tx-2">
          What Docker says is running there now
        </p>
        {services.isPending ? (
          <Skeleton className="mt-2 h-8 w-full" />
        ) : services.error || rows === null || rows === undefined ? (
          <p className="mt-1.5 text-ui text-tx-2">
            This host would not answer, so Cloudgate cannot say. That is the
            normal reply from a Swarm worker and from a machine that is already
            unreachable — it is not a list of nothing.
          </p>
        ) : rows.length === 0 ? (
          <p className="mt-1.5 text-ui text-tx-2">
            No Swarm services. Anything running as a plain container would not
            be in this answer, so the Docker &amp; Swarm tab is the fuller
            picture.
          </p>
        ) : (
          <>
            <ul className="mt-1.5 flex flex-col gap-1">
              {rows.map((service) => (
                <li
                  key={service.ID}
                  className="flex flex-wrap items-baseline gap-x-2 text-ui text-tx"
                >
                  <span className="font-mono">{service.Name}</span>
                  <span className="num text-meta text-tx-3">
                    {service.Replicas}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-meta text-tx-3">
              These are Docker&rsquo;s names. Nothing records which Project or
              Environment each one belongs to, so Cloudgate cannot tell you
              here.
            </p>
          </>
        )}
      </div>
    </ConfirmDeleteModal>
  );
}
