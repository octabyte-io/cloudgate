import type { QueryClient } from "@tanstack/react-query";

import { databasesApi, type Database } from "@/lib/api/endpoints/databases";
import { keys, type OrganizationScope } from "@/lib/api/keys";
import type { LiveLog, LogEnding } from "@/lib/realtime/live-log";
import { watchServiceStatus } from "@/lib/realtime/service-status-watch";

import { LIVE_POLL_MS } from "./use-database";

/** What a database's Runtime log says while the database is stopped. */
export const DATABASE_STOPPED: LogEnding = {
  mark: "stopped",
  words: "Database stopped",
  sentence:
    "The database is stopped — its Swarm service has no running task, so nothing is being written.",
};

/**
 * Have a database's Runtime log follow the Database row's status wherever the
 * log is read — on the Overview, or in the Dock once the page is gone — with
 * the page box's rules (`watchServiceStatus`, which an Application's Logs tab
 * shares). On the key `useDatabase` uses, so the page's read is the one read.
 *
 * Returns the stop, which the log calls when it ends, or `null` before the
 * Organization is known — nothing started, so `LiveLog.watch` tries again.
 */
export function watchDatabase(
  client: QueryClient,
  organizationId: OrganizationScope,
  database: Database,
  log: LiveLog,
): (() => void) | null {
  if (organizationId === null) return null;
  const { kind, databaseId } = database;
  return watchServiceStatus({
    client,
    queryKey: keys.databases.detail(organizationId, kind, databaseId),
    queryFn: () => databasesApi.findOne(kind, databaseId),
    status: database.applicationStatus,
    log,
    stopped: DATABASE_STOPPED,
    pollMs: LIVE_POLL_MS,
  });
}
