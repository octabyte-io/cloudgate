import { Card } from "@/components/console/card";
import { Dot } from "@/components/console/dot";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import {
  lastReach,
  type Server,
  type StoredOutcome,
} from "@/lib/api/endpoints/servers";
import { timeAgo, timeExact } from "@/lib/format/time";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { useValidateServer } from "../use-server";

/**
 * Can Cloudgate reach this machine?
 *
 * `GET /servers/:id/validate` runs `echo ok` over SSH — the smallest possible
 * question — and **the interesting answer is the failure**. The service catches
 * whatever ssh2 threw and re-raises it as a 400 carrying the message, so
 * "All configured authentication methods failed", "connect ECONNREFUSED
 * 203.0.113.10:22" and "getaddrinfo ENOTFOUND" all arrive as text that names the
 * problem. That message is the entire value of this control, which is why it is
 * rendered here in full rather than run through a sentence of our own.
 *
 * **The result goes on the screen, not into a toast**, and that is deliberate: this
 * is diagnostic output somebody reads twice while they change a setting and press it
 * again. A toast for it would take the one thing they need away after four seconds.
 *
 * **And the answer outlives the tab.** It used to be this mount's
 * mutation and nothing else, so a failed check read "Nothing has been checked
 * yet" after a round trip to another tab, one card above an audit still saying
 * "could not reach". The backend now stores the last attempt — this button,
 * the audit, a setup run — and the card falls back to it.
 *
 * **It is also what the pill beside the Server's name says**: the
 * stored outcome, rather than `serverStatus`, which only cloud billing writes.
 */
export function ReachabilityCard({ server }: { server: Server }) {
  const check = useValidateServer(server.serverId);
  const noKey = server.sshKeyId === null;
  // This mount's own answer while it has one — it carries SSH's error as the
  // request raised it — and otherwise the stored one, which is what survives
  // leaving the tab.
  const outcome: StoredOutcome | null = check.isSuccess
    ? { ok: true, at: new Date(check.submittedAt).toISOString(), message: null }
    : check.isError
      ? {
          ok: false,
          at: new Date(check.submittedAt).toISOString(),
          message: errorMessage(check.error),
        }
      : lastReach(server);
  const when = outcome ? timeAgo(outcome.at) : null;
  // A check's answer replaces "Opening an SSH session…" in place, so it fades
  // in; an outcome read off the row on arrival is simply there.
  const answered =
    check.isSuccess || check.isError ? "animate-fade" : undefined;

  return (
    <Card>
      <Card.Header
        title="Reaching this Server"
        sub={
          <span className="wrap-anywhere">
            Cloudgate signs in as {server.username} on {server.ipAddress}:
            {server.port}.
          </span>
        }
        headingLevel={2}
        actions={
          // Not primary: Run setup is this tab's one primary action,
          // and this button only asks.
          <Button
            size="sm"
            onClick={() => check.mutate()}
            disabled={check.isPending || noKey}
            aria-busy={check.isPending || undefined}
          >
            <Icon name="buoy" size={14} />
            Check now
          </Button>
        }
      />
      <Card.Body>
        {noKey ? (
          <p className="text-body text-tx-2">
            This Server has no SSH key, so there is nothing to check with.
            Choose one on the Access tab first.
          </p>
        ) : check.isPending ? (
          <p className="text-body text-tx-2">
            Opening an SSH session and running{" "}
            <code className="font-mono">echo ok</code>.
          </p>
        ) : outcome?.ok ? (
          <p
            className={cn("flex items-baseline gap-2 text-body text-tx", answered)}
          >
            <Dot mark={{ tone: "ok", glyph: "●", label: "reachable" }} />
            <span>
              Cloudgate reached it and ran a command{" "}
              <time dateTime={outcome.at} title={timeExact(outcome.at)}>
                {when}
              </time>
              .
            </span>
          </p>
        ) : outcome ? (
          <div className={answered}>
            <p className="flex items-baseline gap-2 text-body text-tx">
              <Dot mark={{ tone: "bad", glyph: "○", label: "not reachable" }} />
              <span>
                Cloudgate could not reach it{" "}
                <time dateTime={outcome.at} title={timeExact(outcome.at)}>
                  {when}
                </time>
                .
              </span>
            </p>
            {/* SSH's own words. Long, and worth every character of it. */}
            {outcome.message ? (
              <p className="mt-1.5 font-mono text-meta text-tx-2 wrap-anywhere">
                {outcome.message}
              </p>
            ) : null}
            <p className="mt-2 text-meta text-tx-3">
              Check the address and port on the Settings tab, that the SSH user
              exists on the machine, and that this key&rsquo;s public half is in
              that user&rsquo;s{" "}
              <code className="font-mono">authorized_keys</code>.
            </p>
          </div>
        ) : (
          <p className="text-body text-tx-2">
            Nothing has been checked yet, which is why this Server is marked
            &ldquo;not checked&rdquo; beside its name.
          </p>
        )}
      </Card.Body>
    </Card>
  );
}
