import { EmptyState } from "@/components/console/empty-state";
import { LinkButton } from "@/components/console/link-button";
import { Button } from "@/components/ui/button";
import type { RequestsRead } from "@/lib/api/endpoints/monitoring";
import { REQUEST_LOGGING_ANCHOR } from "@/lib/shell/tabs/server";

/**
 * What the Requests page says instead of "0 requests" when a read has nothing
 * to show: one centred message that names the Server — an icon, a
 * title, one or two sentences and at most two buttons. It replaces the chart
 * and the table; the screen greys the filters and keeps the picker live.
 *
 * **No Restart button, on purpose.** Turning logging on is one action on the
 * Server's Request logging card that also restarts Traefik; this page
 * only links there, and only for the people that card lets switch it.
 */
export function UnreadMessage({
  read,
  organizationName,
  onRetry,
  onLastFifteenMinutes,
}: {
  read: RequestsRead;
  /** The Server's Organization, for "ask an owner or admin of …". */
  organizationName: string;
  onRetry: () => void;
  onLastFifteenMinutes: () => void;
}) {
  const name = read.target.name;
  const serverId = read.target.serverId;
  const settings =
    serverId !== null && read.canSwitchLogging ? (
      <LinkButton
        variant="pri"
        href={`/servers/${serverId}/settings#${REQUEST_LOGGING_ANCHOR}`}
      >
        Open {name} settings
      </LinkButton>
    ) : null;

  switch (read.state) {
    case "unreachable":
      return (
        <EmptyState
          icon="net"
          title={`Can't reach ${name}`}
          action={
            <Actions>
              <Button onClick={onRetry}>Try again</Button>
              {serverId !== null ? (
                <LinkButton href={`/servers/${serverId}/infrastructure`}>
                  Server status
                </LinkButton>
              ) : null}
            </Actions>
          }
        >
          Cloudgate could not open an SSH connection to it. Cloudgate keeps
          nothing it reads, so there is nothing older to show.
        </EmptyState>
      );
    case "logging-off":
      return (
        <EmptyState
          icon="list"
          title={`Request logging is off on ${name}`}
          action={settings}
        >
          {serverId === null
            ? read.canSwitchLogging
              ? "Turn it on with the Request logging card above, and Traefik starts recording the requests your Services receive."
              : "Only an owner or admin of the Instance organization can turn it on."
            : read.canSwitchLogging
              ? "Turn it on from the Request logging card in its settings, and Traefik starts recording the requests your Services receive."
              : `Only an owner or admin of ${organizationName} can turn it on.`}
        </EmptyState>
      );
    case "awaiting-restart":
      return (
        <EmptyState
          icon="restore"
          title={`Waiting for Traefik to restart on ${name}`}
          action={settings}
        >
          {read.canSwitchLogging
            ? "Request logging is on, but Traefik has not restarted with it yet, so nothing is being recorded. Switch it from the Request logging card to restart Traefik."
            : serverId === null
              ? "Request logging is on, but Traefik has not restarted with it yet, so nothing is being recorded. Ask an owner or admin of the Instance organization to finish the change."
              : `Request logging is on, but Traefik has not restarted with it yet, so nothing is being recorded. Ask an owner or admin of ${organizationName} to finish the change.`}
        </EmptyState>
      );
    case "empty":
      return (
        <EmptyState icon="activity" title={`No requests yet on ${name}`}>
          Request logging is on. Nothing has arrived since Traefik started.
        </EmptyState>
      );
    case "too-slow":
      return (
        <EmptyState
          icon="clock"
          title={`Reading ${name} took too long`}
          action={
            <Actions>
              <Button variant="pri" onClick={onLastFifteenMinutes}>
                Try the last 15 minutes
              </Button>
              <Button onClick={onRetry}>Try again</Button>
            </Actions>
          }
        >
          Cloudgate stopped after 10 seconds. A shorter range reads less of the
          log.
        </EmptyState>
      );
    default:
      return null;
  }
}

/**
 * The page with no Server to read: what Requests is for, Add a Server for
 * whoever may add one, and — when the Organization's Services run in a Cloud
 * account — where those requests are logged instead.
 */
export function NoServersMessage({
  canAddServer,
  cloudAccountServices,
}: {
  canAddServer: boolean;
  cloudAccountServices: boolean;
}) {
  return (
    <EmptyState
      icon="server"
      title="No Servers yet"
      action={
        canAddServer ? (
          <LinkButton variant="pri" href="/servers">
            Add a Server
          </LinkButton>
        ) : null
      }
    >
      Requests shows the traffic your Services receive on your own Servers.
      {cloudAccountServices
        ? " Services in a Cloud account have no Server here: their requests are in your cloud's own load balancer or CDN logs."
        : null}
    </EmptyState>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap justify-center gap-2">{children}</div>;
}
