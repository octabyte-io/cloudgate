import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { LinkButton } from "@/components/console/link-button";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { errorMessage } from "@/lib/api/error-message";
import type { Server } from "@/lib/api/endpoints/servers";
import { useTerminalOffers } from "@/components/shell/dock-context";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { BoughtServerNotice } from "./bought-server-notice";
import { MaintenanceNotice } from "./maintenance-notice";
import { PoweredOffNotice } from "./powered-off-notice";
import { serverShellOffers } from "./shell-offers";
import { useServer } from "./use-server";

/**
 * The three states every Server panel opens in, once — F11's `DatabasePanel`, and
 * seven tabs is a better argument for it than five were.
 *
 * **A bad id never reaches here.** `useScopeQueries` marks the scope `missing` on a
 * 404 from the identity query and the route renders `Outcome` (F07). What lands here
 * is the other kind — a 403, or the backend not answering — where the Server exists
 * and this screen cannot read it. The shell around it stays, because the rail and
 * the masthead are still telling the truth.
 *
 * Every tab carries **one shared action: open a shell**. A terminal is the thing
 * someone reaches for from wherever they happen to be when a machine surprises them,
 * so it is in the header rather than only on its own tab — and it is a *link*, not a
 * button, so it can be opened in a new tab beside whatever you were reading.
 */
export function ServerPanel({
  panel,
  children,
  aside,
  actions,
}: {
  panel: PanelProps;
  /** Called only with a real row. */
  children: (row: Server) => React.ReactNode;
  aside?: (row: Server) => React.ReactNode;
  /** This tab's own actions, before the shared shell link. */
  actions?: (row: Server) => React.ReactNode;
}) {
  const { id, label, icon } = panel;
  const query = useServer(id);
  const row = query.data;
  // The screen rises in only when this visit waited on the skeleton below; a
  // Server already in the cache (every tab after the first) is simply there.
  const [arrives] = useState(() => !query.data);
  const arrival = arrives ? "animate-rise" : undefined;

  if (query.error) {
    return (
      <Page>
        <PageHeader title={label} icon={icon} />
        <Cols>
          <Card>
            <Card.Body>
              <p className="text-body text-tx-2">{errorMessage(query.error)}</p>
            </Card.Body>
          </Card>
        </Cols>
      </Page>
    );
  }

  if (!row) {
    return (
      <Page>
        <PageHeader title={label} icon={icon} />
        <Cols>
          <Card>
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          </Card>
        </Cols>
      </Page>
    );
  }

  return (
    <Page>
      <OfferServerShell server={row} />
      <PageHeader
        title={label}
        icon={icon}
        actions={
          <>
            {actions?.(row)}
            {panel.label === "Terminal" ? null : (
              <LinkButton href={`/servers/${row.serverId}/terminal`}>
                <Icon name="term" size={15} />
                Open a shell
              </LinkButton>
            )}
          </>
        }
      />
      <PoweredOffNotice server={row} />
      <MaintenanceNotice server={row} />
      <BoughtServerNotice server={row} />
      {aside ? (
        <Cols
          aside={aside(row)}
          asideLabel={`About ${row.name}`}
          className={arrival}
        >
          {children(row)}
        </Cols>
      ) : (
        <Cols className={arrival}>{children(row)}</Cols>
      )}
    </Page>
  );
}

/**
 * Every Server tab offers its Server's shell under the Dock's `+`,
 * to a caller the gateway would let in (`serverShellOffers`).
 */
function OfferServerShell({ server }: { server: Server }) {
  const verdict = usePermission({ server: ["read"] });
  useTerminalOffers(serverShellOffers(server, verdict));
  return null;
}
