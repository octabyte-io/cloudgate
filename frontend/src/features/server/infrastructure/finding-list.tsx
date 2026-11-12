import { Card } from "@/components/console/card";
import { Dot } from "@/components/console/dot";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { isUnreachableHost } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { ServerAudit } from "@/lib/api/endpoints/servers";
import { Icon } from "@/lib/design/icons";
import { TONE_TEXT } from "@/lib/design/status";
import { cn } from "@/lib/utils";
import type { UseQueryResult } from "@tanstack/react-query";

import type { AuditFinding } from "./audit-findings";

/**
 * A card of audit findings, and the four states the audit itself has.
 *
 * The Infrastructure tab and the Access tab both render one of these from the same
 * query, so the states are decided once. **Three of the four say different things**
 * and conflating any two of them is how this screen would start lying:
 *
 * - **In flight** — the script is running on the host, over SSH, which takes a
 *   second or two on a good connection and longer on a bad one.
 * - **Refused** — usually the host itself: the audit runs `execAsyncRemote`, so an
 *   unreachable machine arrives here as `503 HOST_UNREACHABLE` and a key the host
 *   will not accept, or cannot be read, as a 400 naming the key —
 *   `errorMessage()` words both. That is not "the host is not ready"; it is "we
 *   could not ask", and the sentence has to say which.
 * - **Answered** — the findings, each with its own reading and its own fix.
 *
 * The tone is carried by a `Dot`, which ships its word in an `sr-only` span, and by
 * the reading beside it in words. Never by the hue alone.
 */
export function FindingList({
  title,
  lede,
  query,
  findings,
  footer,
}: {
  title: string;
  lede?: React.ReactNode;
  query: UseQueryResult<ServerAudit>;
  /** How to read the answer. Called only with a real one. */
  findings: (audit: ServerAudit) => AuditFinding[];
  footer?: React.ReactNode;
}) {
  return (
    <Card>
      <Card.Header
        title={title}
        sub={lede}
        headingLevel={2}
        actions={
          <Button
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-busy={query.isFetching || undefined}
          >
            <Icon name="refresh" size={14} />
            Read again
          </Button>
        }
      />

      {query.isFetching && !query.data ? (
        <Card.Body>
          <p className="mb-2.5 text-body text-tx-2">
            Running the readiness script on the host over SSH.
          </p>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        </Card.Body>
      ) : query.error ? (
        <Card.Body>
          <p className="text-body text-tx">
            Cloudgate could not ask this Server what it has.
          </p>
          <p className="mt-1.5 text-meta text-tx-2 wrap-anywhere">
            {errorMessage(query.error)}
          </p>
          <p className="mt-2 text-meta text-tx-3">
            {/* Only a Server that was not reached is a reaching problem:
                a refused or unreadable key answers a 400, and there the Server
                was reached and turned the key away. */}
            {isUnreachableHost(query.error)
              ? "The check runs over SSH, so this is about reaching the Server rather than about what is installed on it. "
              : null}
            Nothing here has been ruled out.
          </p>
        </Card.Body>
      ) : query.data ? (
        <Card.Body>
          <ul className="flex flex-col">
            {findings(query.data).map((finding) => (
              <li
                key={finding.title}
                className="flex gap-2.5 border-b border-line py-3 last:border-b-0"
              >
                <span className="mt-1 flex-none">
                  <Dot
                    mark={{
                      tone: finding.tone,
                      glyph: finding.tone === "ok" ? "●" : "○",
                      label: finding.reading,
                    }}
                  />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-baseline gap-x-2 text-body text-tx">
                    <span className="font-medium">{finding.title}</span>
                    <span
                      className={cn(
                        "text-meta",
                        finding.tone === "ok"
                          ? "text-tx-2"
                          : TONE_TEXT[finding.tone],
                      )}
                    >
                      {finding.reading}
                    </span>
                  </p>
                  {finding.fix ? (
                    <p className="mt-0.75 text-meta text-tx-2 wrap-anywhere">
                      {finding.fix}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Card.Body>
      ) : null}

      {footer ? <Card.Footer>{footer}</Card.Footer> : null}
    </Card>
  );
}
