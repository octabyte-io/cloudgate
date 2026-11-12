import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import {
  formatDay,
  type AttachedOrganization,
} from "@/lib/api/endpoints/billing";
import { useStopPaying } from "@/lib/api/use-billing";
import { Icon } from "@/lib/design/icons";
import { counted } from "@/lib/format/plural";

/**
 * The confirm before **"Stop paying for it"** (ADR-0059): it says the four
 * things that happen at once — it freezes, it is deleted after 30 days unless
 * its owner pays, its owner is emailed, and it leaves the pool now — and only
 * then detaches it (`useStopPaying`). An Organization with Bought Servers is
 * warned of first: a lapse deletes them at once (ADR-0071), so they go unless
 * it starts paying for itself before the detach.
 *
 * The "Organizations on this plan" card opens it from each row; the "Before
 * <Paying> can move to Starter" checklist's Detach opens the same one.
 * `onStopped` runs after the detach, for a caller with more to do.
 */
export function StopPayingConfirm({
  organization,
  open,
  onOpenChange,
  onStopped,
}: {
  organization: Pick<
    AttachedOrganization,
    "id" | "name" | "owner" | "servers" | "cloudEnvironments" | "boughtServers"
  >;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStopped?: () => void;
}) {
  const stop = useStopPaying();
  const { name, owner } = organization;
  const ownerSaid = owner
    ? owner.name
      ? `${owner.name} (${owner.email})`
      : owner.email
    : null;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Stop paying for ${name}?`}
        description="This plan stops paying for it now, and it lapses on its own."
      />
      <Modal.Body>
        {organization.boughtServers > 0 && (
          <div
            role="alert"
            className="mb-4 flex gap-2.5 rounded-lg border border-bad-line bg-bad-tint px-4 py-2.75"
          >
            <Icon
              name="alert"
              size={15}
              className="mt-0.5 flex-none text-bad"
            />
            <p className="min-w-0 text-ui text-tx">
              <strong className="font-semibold">
                {organization.boughtServers === 1
                  ? `${name}'s Bought Server is deleted at once,`
                  : `${name}'s ${organization.boughtServers} Bought Servers are deleted at once,`}
              </strong>{" "}
              with {organization.boughtServers === 1 ? "its" : "their"} data and
              backups, unless {name}{" "}
              starts paying for itself before you stop. This can&rsquo;t be
              undone.
            </p>
          </div>
        )}
        <ul className="list-disc space-y-1.5 pl-5 text-body text-tx-2">
          <li>
            {name} freezes at once: its Services keep running, but Cloudgate
            starts no deploys, Cron runs, backups, Uptime checks or cloud runs
            for it.
          </li>
          <li>
            It is deleted after 30 days unless its owner pays for it. Its owner
            gets no free trial.
          </li>
          <li>
            {ownerSaid
              ? `${ownerSaid} is emailed, as its owner.`
              : "Its owner is emailed."}
          </li>
          <li>
            It leaves this plan now: its{" "}
            {counted(organization.servers, "Server", "Servers")} and{" "}
            {counted(
              organization.cloudEnvironments,
              "Cloud Environment",
              "Cloud Environments",
            )}{" "}
            stop counting against it.
          </li>
        </ul>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Back</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={stop.isPending}
          aria-busy={stop.isPending || undefined}
          onClick={async () => {
            try {
              const stopped = await stop.mutateAsync(organization.id);
              toast.done(
                `This plan no longer pays for ${name}. It is frozen, and is deleted on ${formatDay(stopped.deletesOn)} unless its owner pays.`,
              );
              onOpenChange(false);
              onStopped?.();
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          Stop paying
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
