import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { QAList } from "@/components/console/qa-row";
import type { BoughtServerView } from "@/lib/api/endpoints/bought-servers";
import type { Server } from "@/lib/api/endpoints/servers";
import { usePermission } from "@/lib/auth/use-permission";

import { useBoughtServer } from "../buy/use-bought-servers";
import { BackUpNow } from "./back-up-now";
import { BoughtServerFacts } from "./bought-server-aside";
import { CHANGE_WAITS_FOR_READY } from "./bought-server-reasons";
import { BoughtServerSizeRow } from "./bought-server-size";
import { ExtraStorageRow } from "./extra-storage-row";
import { ServerBackupsCard } from "./server-backups-card";

/** Said on the switch to a role that may not change what the Organization pays for. */
export const BOUGHT_SERVER_CHANGE_REFUSAL =
  "Your role in this Organization cannot change what this Server is charged for. Ask an owner or an admin.";

/**
 * The **Bought Server** tab (ADR-0071, #198), in the three places its
 * panel lays it out: the header's actions, the main column and the aside.
 * Each reads the same `GET /bought-servers/:id` and shows nothing until it
 * answers, or for a Server that was not bought.
 *
 * Every change asks first; while one runs the header says **Changing** and
 * every control waits.
 */
export function BoughtServerActions({ server }: { server: Server }) {
  const bought = useBoughtServer(server.serverId);
  const view = bought.data;
  if (!view) return null;
  return (
    <>
      {view.stage === "changing" ? <Chip variant="warn">Changing</Chip> : null}
      <BackUpNow view={view} />
    </>
  );
}

/** Server backups, then Size and storage. */
export function BoughtServerMain({ server }: { server: Server }) {
  const bought = useBoughtServer(server.serverId);
  if (!bought.data) return null;
  return <BoughtServerChanges view={bought.data} server={server} />;
}

/** What you pay, and About this Server. */
export function BoughtServerAside({ server }: { server: Server }) {
  const bought = useBoughtServer(server.serverId);
  if (!bought.data) return null;
  return <BoughtServerFacts view={bought.data} />;
}

function BoughtServerChanges({
  view,
  server,
}: {
  view: BoughtServerView;
  server: Server;
}) {
  const canChange = usePermission({ server: ["create"] });
  /** Why the switch and the size and storage rows wait, if they do. */
  const rowWhy = !canChange.allowed
    ? BOUGHT_SERVER_CHANGE_REFUSAL
    : view.stage !== "ready"
      ? CHANGE_WAITS_FOR_READY
      : null;

  return (
    <>
      <ServerBackupsCard view={view} server={server} rowWhy={rowWhy} />
      <Card>
        <Card.Header
          title="Size and storage"
          sub="Each change asks first and says what it costs."
          headingLevel={2}
        />
        <Card.Body>
          <QAList>
            <BoughtServerSizeRow view={view} why={rowWhy} />
            <ExtraStorageRow view={view} why={rowWhy} />
          </QAList>
          {rowWhy && canChange.allowed ? (
            <p className="mt-2 text-meta text-tx-3">{rowWhy}</p>
          ) : null}
        </Card.Body>
      </Card>
    </>
  );
}
