import type { Server } from "@/lib/api/endpoints/servers";
import { timeExact } from "@/lib/format/time";

/**
 * A Server in **Maintenance** (spec #1420): every tab says since when, and
 * that nothing new will start on it, so nobody reads a refused deploy as a
 * broken Server. The powered-off notice's pattern; nothing while it is not in
 * maintenance. Who started it is not said: the read model carries a user id,
 * not a name.
 */
export function MaintenanceNotice({
  server,
}: {
  server: Pick<Server, "maintenanceSince">;
}) {
  const since = server.maintenanceSince;
  if (!since) return null;
  return (
    <div
      role="status"
      data-slot="maintenance-notice"
      className="mb-4 rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-body text-tx"
    >
      In maintenance since <time dateTime={since}>{timeExact(since)}</time>.
      Nothing new will start on this Server.
    </div>
  );
}
