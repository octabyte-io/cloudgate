import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { QAList, QARow } from "@/components/console/qa-row";
import type { Server } from "@/lib/api/endpoints/servers";

/**
 * Where a **Bought Server**'s card went (#198): its Server backups, size,
 * extra storage and price moved from Settings to its own Bought Server tab,
 * and this one line points there for whoever learned the old place. Read
 * off the Server row, so it costs no request; nothing for a Server of the
 * customer's own. Delete stays on Settings.
 */
export function BoughtServerMovedLine({ server }: { server: Server }) {
  if (!server.boughtServer) return null;
  return (
    <Card>
      <Card.Body>
        <QAList>
          <QARow
            title="Bought Server"
            description="Its Server backups, size, extra storage and what it costs are on its own tab."
            action={
              <LinkButton href={`/servers/${server.serverId}/bought-server`}>
                Open Bought Server
              </LinkButton>
            }
          />
        </QAList>
      </Card.Body>
    </Card>
  );
}
