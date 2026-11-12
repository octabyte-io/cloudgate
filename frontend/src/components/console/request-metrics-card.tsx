import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Modal } from "@/components/console/modal";
import { QAList, QARow } from "@/components/console/qa-row";
import { RestartTraefikConsequences } from "@/components/console/restart-traefik-consequences";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { traefikApi } from "@/lib/api/endpoints/traefik";
import { errorMessage } from "@/lib/api/error-message";
import type { Gate } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

/** The toast afterwards. "Asked", because the route answers before the restart. */
export const REQUEST_METRICS_DONE =
  "Request metrics are on. Cloudgate has asked Docker to restart Traefik.";

/**
 * **Enable request metrics** on one machine (ADR-0027) — the platform
 * host's Settings → Traefik screen and a Server's Settings tab, beside that
 * machine's other Traefik controls.
 *
 * The button never acts on its own: `POST /settings/traefik/request-metrics`
 * writes static configuration **and restarts Traefik**, so it opens the same
 * restart confirmation every other Restart Traefik opens, in the same words
 * (`RestartTraefikConsequences`). There is no "off": nothing asks for
 * one, and the counters cost a series per service rather than a file.
 *
 * `enabled` is the machine's read — `requestMetricsEnabled` on the Server row,
 * or on the web-server settings for the platform host — and `undefined` while
 * it loads. `readError` is that read's failure, said in place of the state (a
 * failed read is otherwise an `undefined` that never resolves). `gate` is the restart's own: the route takes exactly the authority
 * `POST /settings/traefik/reload` takes.
 */
export function RequestMetricsCard({
  serverId,
  enabled,
  readError,
  gate,
  onEnabled,
}: {
  serverId: string | null;
  enabled: boolean | undefined;
  readError?: unknown;
  gate: Gate;
  /** Refetch whichever read carries `enabled`. */
  onEnabled: () => Promise<unknown>;
}) {
  const [confirming, setConfirming] = useState(false);
  const enable = useMutation({
    mutationFn: () => traefikApi.enableRequestMetrics(serverId),
  });
  const machine = serverId ? "this Server" : "the platform host";

  return (
    <Card>
      <Card.Header
        title="Request metrics"
        sub="What each Service's Error rate is read from."
        headingLevel={2}
      />
      <Card.Body>
        <QAList>
          <QARow
            title={
              <>
                Traefik request counters
                {enabled ? <Chip>On</Chip> : null}
              </>
            }
            description={
              enabled === undefined && readError ? (
                <span role="alert" className="flex gap-2 wrap-anywhere text-tx">
                  <Icon name="alert" className="mt-0.5 flex-none text-bad" />
                  {errorMessage(readError)}
                </span>
              ) : enabled === undefined ? (
                <Skeleton className="h-4 w-48" />
              ) : enabled ? (
                <>
                  Traefik on {machine} keeps a request count per service on{" "}
                  <code className="font-mono">127.0.0.1:8082</code>, inside its
                  own container, where no other container can read it.
                </>
              ) : (
                <>
                  Off. Until it is on, every Service on {machine}{" "}
                  reads
                  &ldquo;request metrics not enabled on this Server&rdquo;
                  instead of an Error rate. Turning it on restarts Traefik.
                </>
              )
            }
            action={
              enabled === false ? (
                <Button
                  type="button"
                  disabled={!gate.allowed}
                  title={gate.allowed ? undefined : gate.refusal}
                  onClick={() => setConfirming(true)}
                >
                  Enable request metrics
                </Button>
              ) : null
            }
          />
        </QAList>
        {enabled === false && !gate.allowed ? (
          <p className="mt-2 text-meta text-tx-3">{gate.refusal}</p>
        ) : null}
      </Card.Body>

      <Modal open={confirming} onOpenChange={setConfirming}>
        <Modal.Header
          title="Enable request metrics and restart Traefik?"
          description={`This is the ingress that serves every domain on ${machine}.`}
        />
        <Modal.Body>
          <RestartTraefikConsequences change="request metrics" />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            variant="dngr"
            disabled={enable.isPending}
            onClick={() => {
              void enable
                .mutateAsync()
                .then(async () => {
                  toast.info(REQUEST_METRICS_DONE);
                  setConfirming(false);
                  await onEnabled();
                })
                .catch((error: unknown) => toast.error(error));
            }}
          >
            Enable and restart Traefik
          </Button>
        </Modal.Footer>
      </Modal>
    </Card>
  );
}
