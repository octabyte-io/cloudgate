import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Modal } from "@/components/console/modal";
import { QAList, QARow } from "@/components/console/qa-row";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { traefikApi } from "@/lib/api/endpoints/traefik";
import { errorMessage } from "@/lib/api/error-message";
import type { Gate } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { REQUEST_LOGGING_ANCHOR } from "@/lib/shell/tabs/server";

/** The fixed rotation limits (ADR-0057), shown read-only. */
export const REQUEST_LOGGING_LIMITS =
  "New file every 100 MiB, keeps 3 older files, deletes them after 30 days";

const DROP_NOTE = "Open connections on ports 80 and 443 drop for a moment.";
const RETENTION_NOTE =
  "Saved logs stay on this Server and are deleted within 30 days.";

/**
 * **Request logging** on one Server: its Traefik **Access log**,
 * switched on or off beside Request metrics in the Server's Settings panel.
 *
 * The switch never acts on its own. `POST /settings/traefik/requests` writes
 * `traefik.yml` and restarts that Server's Traefik in the same request,
 * answering once the restart has run (502 when it failed, the file written), so a
 * flip opens a confirmation first, which says open connections on 80 and 443
 * drop for a moment — and, turning it off, what happens to the logs already
 * saved. `gate` is the restart's own: owner/admin of the Server's
 * Organization.
 *
 * `enabled` is the Server's read (`GET /settings/traefik/requests`), and
 * `undefined` while it loads; `readError` is that read's failure.
 */
export function RequestLoggingCard({
  serverId,
  enabled,
  readError,
  gate,
  onChanged,
}: {
  serverId: string;
  enabled: boolean | undefined;
  readError?: unknown;
  gate: Gate;
  /** Refetch the read that carries `enabled`; given the state asked for. */
  onChanged: (enabled: boolean) => Promise<unknown>;
}) {
  /** The state a pending confirmation would switch to, or null when closed. */
  const [asking, setAsking] = useState<boolean | null>(null);
  const toggle = useMutation({
    mutationFn: (next: boolean) => traefikApi.toggleRequests(next, serverId),
    // Settled, not only on success (CODING_STANDARDS §3.5): a 502 means
    // traefik.yml was written and Traefik did not restart, so the read is
    // what says where the switch stands.
    onSettled: (_answer, _error, next) => onChanged(next),
  });
  const turningOn = asking === true;

  return (
    <Card id={REQUEST_LOGGING_ANCHOR}>
      <Card.Header
        title="Request logging"
        sub="Traefik's access log on this Server: what the Requests page reads."
        headingLevel={2}
      />
      <Card.Body>
        <QAList>
          <QARow
            title="Access log"
            description={
              enabled === undefined && readError ? (
                <span role="alert" className="flex gap-2 wrap-anywhere text-tx">
                  <Icon name="alert" className="mt-0.5 flex-none text-bad" />
                  {errorMessage(readError)}
                </span>
              ) : enabled === undefined ? (
                <Skeleton className="h-4 w-48" />
              ) : (
                <>
                  {enabled
                    ? "On. Traefik records each request's visitor IP, path, status and User-Agent; every other header is dropped."
                    : "Off. Turning it on restarts Traefik on this Server."}{" "}
                  <span className="text-tx-3">{REQUEST_LOGGING_LIMITS}.</span>
                </>
              )
            }
            action={
              enabled === undefined ? null : (
                <Switch
                  checked={enabled}
                  disabled={!gate.allowed || toggle.isPending}
                  title={gate.allowed ? undefined : gate.refusal}
                  aria-label="Request logging on this Server"
                  onCheckedChange={(next) => setAsking(Boolean(next))}
                />
              )
            }
          />
        </QAList>
        {enabled !== undefined && !gate.allowed ? (
          <p className="mt-2 text-meta text-tx-3">{gate.refusal}</p>
        ) : null}
      </Card.Body>

      <Modal
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
      >
        <Modal.Header
          title={
            turningOn
              ? "Turn on request logging and restart Traefik?"
              : "Turn off request logging and restart Traefik?"
          }
          description="This is the ingress that serves every domain on this Server."
        />
        <Modal.Body>
          <p className="text-body text-tx-2">
            Traefik reads this setting only when it starts, so Cloudgate
            restarts it now.{" "}
            <strong className="font-medium text-tx">{DROP_NOTE}</strong>
          </p>
          {turningOn ? null : (
            <p className="mt-3 text-body text-tx-2">{RETENTION_NOTE}</p>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            variant="dngr"
            disabled={toggle.isPending}
            onClick={() => {
              const next = turningOn;
              void toggle
                .mutateAsync(next)
                .then(() => {
                  toast.info(
                    `Request logging is ${next ? "on" : "off"}, and Traefik has restarted.`,
                  );
                  setAsking(null);
                })
                .catch((error: unknown) => toast.error(error));
            }}
          >
            {turningOn
              ? "Turn on and restart Traefik"
              : "Turn off and restart Traefik"}
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}
