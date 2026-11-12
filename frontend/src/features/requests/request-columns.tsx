import { Chip } from "@/components/console/chip";
import type { Column } from "@/components/console/data-table";
import type { RequestRow } from "@/lib/api/endpoints/monitoring";
import { TONE_PILL, type Tone } from "@/lib/design/status";
import { clockTime } from "@/lib/format/time";
import { cn } from "@/lib/utils";

/**
 * One Traefik access-log line, as a table row: Status · Method · Host and
 * path · Took · Size · Service · Client · When. Query values in the path
 * arrive from the backend as `***`, their names kept, and are shown as sent.
 *
 * **The status column is the one worth reading twice.** A status class is carried
 * by a tone *and* by the number itself — the number is always there, never replaced
 * by a coloured pill, because 404 and 410 are the same tone and completely
 * different afternoons. That is the contract in `00-INDEX.md` ("always paired with
 * the number, never hue alone") and the `dataviz` rule about status colour in the
 * same breath.
 *
 * **`0` is not a status.** Traefik writes `DownstreamStatus: 0` when it never got
 * an answer to relay — the backend refused the connection, or the request was cut
 * off. Rendering that as a number in a status column would invite somebody to look
 * up what HTTP 0 means, so it reads "no reply" and takes the `bad` tone.
 *
 * **Durations are nanoseconds** and they are formatted, not converted to one unit:
 * a 1.2ms request and a 3.4s request in the same column both need to be readable at
 * a glance, and `0.0012s` is not.
 */

/**
 * Which tone a status wears, and the word that travels with it. The colour is
 * `TONE_PILL`'s, so a status here cannot drift from a status pill elsewhere.
 */
function statusTone(status: number): { tone: Tone; word: string } {
  if (status === 0) return { tone: "bad", word: "no reply" };
  if (status >= 500) return { tone: "bad", word: "server error" };
  if (status >= 400) return { tone: "warn", word: "client error" };
  if (status >= 300) return { tone: "mute", word: "redirected" };
  if (status >= 200) return { tone: "ok", word: "succeeded" };
  return { tone: "mute", word: "informational" };
}

/** Nanoseconds → the unit that makes the number readable. */
export function duration(nanos: number): string {
  if (!Number.isFinite(nanos) || nanos < 0) return "—";
  const ms = nanos / 1_000_000;
  if (ms < 1) return `${(nanos / 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(1)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Bytes, in the unit the number fits. */
function size(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * `service: false` leaves the Service column out, for a Service's own
 * Requests tab, where every line is that Service's.
 */
export function requestColumns({
  service = true,
}: { service?: boolean } = {}): Column<RequestRow>[] {
  const columns: Column<RequestRow>[] = [
    {
      id: "status",
      head: "Status",
      // Sorting is by the code, which is the useful order: it groups the classes
      // and separates 404 from 410 inside one.
      compare: (a, b) => a.DownstreamStatus - b.DownstreamStatus,
      cell: (row) => {
        const tone = statusTone(row.DownstreamStatus);
        const noReply = row.DownstreamStatus === 0;
        return (
          <span
            className={cn(
              "inline-flex items-center gap-1.25 rounded-md border px-1.5 py-0.5 text-chip",
              TONE_PILL[tone.tone],
            )}
          >
            {/* The dash is decoration beside the visible "no reply"; a
                number is read with its class word, which only a screen
                reader needs spelled out. */}
            <span
              aria-hidden={noReply || undefined}
              className="num font-semibold"
            >
              {noReply ? "—" : row.DownstreamStatus}
            </span>
            {noReply ? (
              <span>no reply</span>
            ) : (
              <span className="sr-only">{tone.word}</span>
            )}
          </span>
        );
      },
    },
    {
      id: "method",
      head: "Method",
      compare: (a, b) => a.RequestMethod.localeCompare(b.RequestMethod),
      cell: (row) => (
        <span className="num text-tx-2">{row.RequestMethod || "—"}</span>
      ),
    },
    {
      id: "host",
      head: "Host and path",
      tone: "key",
      truncate: true,
      compare: (a, b) =>
        `${a.RequestHost ?? ""}${a.RequestPath ?? ""}`.localeCompare(
          `${b.RequestHost ?? ""}${b.RequestPath ?? ""}`,
        ),
      cell: (row) => (
        <>
          <span className="truncate" title={row.RequestHost || undefined}>
            {row.RequestHost || "—"}
          </span>
          <span
            className="mt-0.5 block truncate font-mono text-meta font-normal text-tx-3"
            title={row.RequestPath || undefined}
          >
            {row.RequestPath || "/"}
          </span>
        </>
      ),
    },
    {
      id: "duration",
      head: "Took",
      tone: "num",
      compare: (a, b) => a.Duration - b.Duration,
      cell: (row) => duration(row.Duration),
    },
    {
      id: "size",
      head: "Size",
      tone: "num",
      compare: (a, b) => a.DownstreamContentSize - b.DownstreamContentSize,
      cell: (row) => size(row.DownstreamContentSize),
    },
    {
      id: "service",
      head: "Service",
      truncate: true,
      compare: (a, b) =>
        (a.service?.name ?? "").localeCompare(b.service?.name ?? ""),
      // The Cloudgate Service whose Domain the line matched. `null` is a line
      // that matched none — a scanner, an unknown host — and only a
      // `server: ['read']` holder is ever sent one on a Server, and only the
      // Instance organization's authority on the platform host (ADR-0061).
      cell: (row) =>
        row.service === undefined ? (
          <span className="text-tx-3">—</span>
        ) : row.service === null ? (
          <Chip>No Service</Chip>
        ) : (
          <span className="block truncate text-tx-2" title={row.service.name}>
            {row.service.name}
          </span>
        ),
    },
    {
      id: "client",
      head: "Client",
      compare: (a, b) => a.ClientHost.localeCompare(b.ClientHost),
      // The visitor's IP, and the User-Agent under it — the one request header
      // a Server's Traefik keeps — so a browser, a bot and a script read apart.
      cell: (row) => (
        <>
          <span className="block font-mono text-meta text-tx-2">
            {row.ClientHost || "—"}
          </span>
          {row["request_User-Agent"] ? (
            <span
              className="mt-0.5 block max-w-80 truncate text-meta text-tx-3"
              title={row["request_User-Agent"]}
            >
              {row["request_User-Agent"]}
            </span>
          ) : null}
        </>
      ),
    },
    {
      id: "when",
      head: "When",
      tone: "num",
      compare: (a, b) => a.StartUTC.localeCompare(b.StartUTC),
      // `title` carries the full stamp; the cell shows the clock time, because a
      // log is scanned for "the burst at 14:32" and a date repeated on 50 rows
      // is 50 copies of the same fact.
      cell: (row) => (
        <time dateTime={row.StartUTC} title={row.StartUTC}>
          {clockTime(row.StartUTC)}
        </time>
      ),
    },
  ];
  return service
    ? columns
    : columns.filter((column) => column.id !== "service");
}
