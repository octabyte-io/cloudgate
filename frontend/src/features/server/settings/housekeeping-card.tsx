import { Card } from "@/components/console/card";
import { QAList, QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import type { Server } from "@/lib/api/endpoints/servers";

import { useSetDockerCleanup } from "../use-server";

/**
 * The one column `PATCH /servers/:id` cannot reach.
 *
 * `updateServerSchema` does not carry `enableDockerCleanup`, so
 * `POST /settings/docker-cleanup` is the only writer there is. It is a switch here
 * rather than nowhere, because the column is about *this Server* and a person
 * looking for it would look here — and it saves on the spot rather than with the
 * cards above, because it is a different route.
 */
export function HousekeepingCard({ server }: { server: Server }) {
  const cleanup = useSetDockerCleanup(server.serverId);

  async function toggle(next: boolean) {
    try {
      await cleanup.mutateAsync(next);
      toast.done(
        next
          ? "Nightly cleanup turned on for this Server."
          : "Nightly cleanup turned off for this Server.",
      );
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <Card>
      <Card.Header title="Housekeeping" headingLevel={2} />
      <Card.Body>
        <QAList>
          <QARow
            title="Prune Docker nightly"
            description="Runs a docker system prune on this machine on a cron, reclaiming stopped containers, unused images and dangling build cache. It cannot touch a volume."
            action={
              <Switch
                checked={server.enableDockerCleanup}
                disabled={cleanup.isPending}
                aria-label="Prune Docker nightly on this Server"
                onCheckedChange={(next) => void toggle(Boolean(next))}
              />
            }
          />
        </QAList>
      </Card.Body>
      <Card.Footer>
        This switch is owner or admin only, and it is the one setting on this
        tab that is written by a different route — which is why it saves on the
        spot rather than with the cards above.
      </Card.Footer>
    </Card>
  );
}
