import { Chip } from "@/components/console/chip";
import type { Column } from "@/components/console/data-table";
import { Dash } from "@/components/console/dash";
import { RowTime } from "@/components/console/rows/cells";
import { Button } from "@/components/ui/button";
import type { UserSession } from "@/lib/api/endpoints/users";

/**
 * One row per session, and **the current one gets Sign out rather than Revoke.**
 *
 * They are different actions: revoking a session is a write about somebody else's
 * browser, while ending your own session has to go through the sign-out path so this
 * tab stops holding a session it no longer has. Labelling both "Revoke" would make
 * one of them lie.
 *
 * **Revoke carries the session's `id`**, not its token — the token is
 * never on the wire, and `id` is what `POST /users/me/sessions/revoke` takes.
 */
export function sessionColumns({
  currentId,
  busySessionId,
  signingOut,
  onSignOut,
  onRevoke,
}: {
  /** The session this tab is using. */
  currentId: string | undefined;
  /** The id of a revoke in flight, so its own row says so. */
  busySessionId: string | null;
  signingOut: boolean;
  onSignOut: () => void;
  onRevoke: (sessionId: string) => void;
}): Column<UserSession>[] {
  return [
    {
      id: "device",
      head: "Device",
      tone: "key",
      // The column takes the width the others leave, and the agent ends in an
      // ellipsis inside it. Not `flex-wrap`: wrapping would move the chip
      // under a string that is then free to be as wide as it likes.
      truncate: true,
      cell: (row) => (
        <span className="flex items-center gap-1.75">
          <span className="min-w-0 truncate" title={row.userAgent ?? undefined}>
            {row.userAgent ?? <Dash word="Unknown" />}
          </span>
          {row.id === currentId ? (
            // `flex-none`: the agent is what gives way, never the chip.
            <Chip variant="brand" className="flex-none">
              This session
            </Chip>
          ) : null}
        </span>
      ),
    },
    {
      id: "ip",
      head: "Address",
      tone: "muted",
      cell: (row) =>
        row.ipAddress ? (
          <span className="font-mono">{row.ipAddress}</span>
        ) : (
          <Dash word="Unknown" />
        ),
    },
    {
      id: "started",
      head: "Started",
      cell: (row) => <RowTime iso={row.createdAt} />,
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
    },
    {
      id: "expires",
      head: "Expires",
      cell: (row) => <RowTime iso={row.expiresAt} />,
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      className: "w-24 text-right",
      cell: (row) =>
        row.id === currentId ? (
          <Button
            type="button"
            size="xs"
            disabled={signingOut}
            aria-busy={signingOut || undefined}
            onClick={onSignOut}
          >
            Sign out
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="dngr"
            disabled={busySessionId === row.id}
            aria-busy={busySessionId === row.id || undefined}
            onClick={() => onRevoke(row.id)}
          >
            Revoke
          </Button>
        ),
    },
  ];
}
