import { useTerminalOffers } from "@/components/shell/dock-context";
import type { TerminalOffer } from "@/components/shell/terminal-offers";
import type { ServiceContainer } from "@/lib/api/endpoints/docker";
import type { TabSubject } from "@/lib/shell/tab-registry";
import { noShell } from "@/lib/shell/tabs/shell";

import {
  chosenContainer,
  shellTarget,
  type ShellService,
} from "./service-shell";
import { useServiceContainers } from "./use-service-containers";

/**
 * A Service page's offer under the Dock's `+`: the shell its Shell
 * tab opens first — the first running container, by the same
 * `shellTarget` — so the row reads `storefront · production · Demo Shop` and
 * an open Shell tab's session is the same `terminalKey`, listed once.
 *
 * Offered only where the Shell tab is (`noShell`, the tab's own rule): not for
 * a Service in a Cloud account, not to a role known to lack `service:update`.
 * There the container listing is not asked for at all. A role still being read
 * is asked for, like the tab — and the listing, gated on the same action as
 * the socket, refuses it and so offers nothing.
 *
 * Mounted by each Service scope's layout, so every tab offers it. The listing
 * is the Shell tab's own query (`useServiceContainers`, the same key), so the
 * tab and the offer share one `docker ps` within its stale time
 * (`SERVICE_CONTAINERS_STALE_MS`).
 */
export function OfferServiceShell({
  service,
  subject,
}: {
  /** `null` until the Service's row is read. */
  service: ShellService | null;
  /** The scope's facts the Shell tab is decided on. */
  subject: TabSubject;
}) {
  const shown = service !== null && noShell(service.noun)(subject) === null;
  const containers = useServiceContainers(
    service?.serviceType ?? "application",
    service?.serviceId ?? "",
    { enabled: shown },
  );
  useTerminalOffers(
    shown ? serviceShellOffers(service, containers.data ?? []) : [],
  );
  return null;
}

function serviceShellOffers(
  service: ShellService,
  rows: readonly ServiceContainer[],
): TerminalOffer[] {
  const container = chosenContainer(rows, null);
  return container ? [{ target: shellTarget(service, container) }] : [];
}
