import { useMutation, useQuery } from "@tanstack/react-query";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import {
  TeardownReportModal,
  useTeardownReport,
} from "@/components/console/teardown-report-modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import {
  DEFAULT_TRACE_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
  TRACE_STORE_FRAME_SANDBOX,
  traceStoreSearchPath,
  tracesApi,
  type PutTracesInput,
  type TraceRetentionDays,
  type Traces,
  type TracesServiceType,
} from "@/lib/api/endpoints/traces";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { Icon, type IconName } from "@/lib/design/icons";
import type { Mark } from "@/lib/design/status";
import { readBytes } from "@/lib/format/units";

const daysLabel = (days: number) => (days === 1 ? "1 day" : `${days} days`);

/** The store as the read found it, as one mark. */
function storeMark(traces: Pick<Traces, "enabled" | "storeRunning">): Mark {
  if (!traces.enabled) return { glyph: "⊘", tone: "mute", label: "Off" };
  if (!traces.storeRunning) return { glyph: "○", tone: "mute", label: "On" };
  return { glyph: "●", tone: "ok", label: "On" };
}

/** A retention the backend answered, or the default for one it never set. */
const retentionOf = (days: number): TraceRetentionDays =>
  (TRACE_RETENTION_DAYS as readonly number[]).includes(days)
    ? (days as TraceRetentionDays)
    : DEFAULT_TRACE_RETENTION_DAYS;

/** One of the tab's notes: an info glyph, then the sentence. */
function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="inline-flex items-start gap-1.5 text-meta text-tx-2">
      <Icon name="info" size={14} />
      <span>{children}</span>
    </p>
  );
}

/** How long before its token expires the frame is given a new one. */
const FRAME_RENEW_BEFORE_MS = 60_000;

/**
 * The store's UI, framed under a frame token minted for this viewer. A token
 * is accepted for minutes, so a new one is asked for just before it expires,
 * which reopens the frame on the search page: a frame left on its old one
 * would fail every request from then on.
 */
function TraceStoreFrame({ serviceId }: { serviceId: string }) {
  const { organizationId } = useActiveOrganizationId();
  const frame = useQuery({
    queryKey: keys.traces.frame(organizationId, serviceId),
    queryFn: () => tracesApi.frame(serviceId),
    // A refetch is a new token and so a reloaded frame: only on the clock.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      const expiresAt = query.state.data?.expiresAt;
      if (!expiresAt) return false;
      return Math.max(Date.parse(expiresAt) - Date.now() - FRAME_RENEW_BEFORE_MS, 30_000);
    },
  });
  if (frame.error && !frame.data) {
    return (
      <Card.Body>
        <p className="text-body text-tx-2">{errorMessage(frame.error)}</p>
      </Card.Body>
    );
  }
  if (!frame.data) {
    return (
      <Card.Body>
        <Skeleton className="h-frame" />
      </Card.Body>
    );
  }
  return (
    <iframe
      title="Traces of this Service"
      src={traceStoreSearchPath(frame.data)}
      sandbox={TRACE_STORE_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      className="h-frame w-full animate-fade rounded-lg border-0"
    />
  );
}

/**
 * **The Traces tab** (ADR-0028): the Service's traces
 * setting, its Trace store as it is now, and the store's own search, framed.
 *
 * - **The setting** — on or off, retention, whether a credential exists, and
 *   the store's size on disk (Badger has no disk cap, so this is what an
 *   operator watches). Every write is off, with the reason, for a role
 *   without `service: ['update']`, the one statement the route takes.
 * - **Turning traces on takes effect at the next deploy**, which is when the
 *   store starts and the Service is handed where to send spans; until the
 *   store runs the tab says so and shows no frame.
 * - **The frame is the store's UI through the backend proxy, sandboxed**
 *   (ADR-0075): the store runs on the Service's own Server, so what it serves
 *   is not trusted, and it runs in an opaque origin that never has the
 *   viewer's session. Its requests carry a frame token instead, minted for
 *   this viewer by `GET /traces/:serviceId/frame`, and the proxy checks
 *   `service: ['read']` on every one. It opens on the search page:
 *   `traceStoreSearchPath` says why not the root.
 * - **A turn-off that left the container or directory behind** says so in the
 *   report every Delete uses; nothing else in the console names those paths.
 *
 * Product copy says "Trace store" and never names the software behind it.
 */
export function TracesPanel({
  serviceType,
  serviceId,
  label,
  icon,
  aside,
}: {
  serviceType: TracesServiceType;
  serviceId: string;
  label: string;
  icon: IconName;
  /** The kind's facts card, as `HealthPanel` takes it. */
  aside?: { node: React.ReactNode; label: string };
}) {
  const { organizationId } = useActiveOrganizationId();
  const read = useQuery({
    queryKey: keys.traces.byService(organizationId, serviceType, serviceId),
    queryFn: () => tracesApi.read(serviceType, serviceId),
    enabled: organizationId !== null && serviceId !== "",
  });
  const invalidate = useInvalidate();
  const put = useMutation({
    mutationFn: (input: PutTracesInput) =>
      tracesApi.put(serviceType, serviceId, input),
    // Settled, not succeeded (§3.5): a write that timed out may still have
    // been saved, and a turn-off may have removed the store either way.
    onSettled: () => invalidate.traces(serviceType, serviceId),
  });
  const canUpdate = usePermission({ service: ["update"] });
  const teardown = useTeardownReport();
  const traces = read.data;

  async function write(input: PutTracesInput, done: string) {
    if (!canUpdate.allowed) return;
    try {
      const clean = await teardown.runDelete(() => put.mutateAsync(input));
      if (clean) toast.done(done);
    } catch (error) {
      toast.error(error);
    }
  }

  const refusal = (action: string) =>
    canUpdate.allowed ? undefined : roleRefusal(action);
  const off = !canUpdate.allowed || put.isPending;

  let body: React.ReactNode;
  let actions: React.ReactNode = null;
  if (read.error && !traces) {
    body = (
      <Card.Body>
        <p className="text-body text-tx-2">{errorMessage(read.error)}</p>
      </Card.Body>
    );
  } else if (!traces) {
    body = (
      <Card.Body>
        <div className="grid gap-2.5" aria-busy="true">
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
        </div>
      </Card.Body>
    );
  } else {
    const retention = retentionOf(traces.retentionDays);
    actions = (
      <Button
        size="sm"
        variant={traces.enabled ? undefined : "pri"}
        disabled={off}
        title={refusal(traces.enabled ? "turn traces off" : "turn traces on")}
        onClick={() =>
          write(
            { enabled: !traces.enabled, retentionDays: retention },
            traces.enabled
              ? "Traces turned off. The Trace store and its traces are removed."
              : "Traces turned on. They start at this Service's next deploy.",
          )
        }
      >
        {traces.enabled ? "Turn off" : "Turn on"}
      </Button>
    );
    body = (
      <Card.Body className="grid gap-3">
        <KVList>
          <KVRow label="Traces" value={<StatusPill mark={storeMark(traces)} />} />
          <KVRow
            label="Retention"
            value={
              <span role="group" aria-label="Retention" className="inline-flex gap-1">
                {TRACE_RETENTION_DAYS.map((days) => (
                  <Button
                    key={days}
                    size="sm"
                    variant={days === retention ? "pri" : undefined}
                    aria-pressed={days === retention}
                    disabled={off}
                    title={refusal("change how long traces are kept")}
                    onClick={() =>
                      days !== retention &&
                      write(
                        { enabled: traces.enabled, retentionDays: days },
                        `Traces are now kept for ${daysLabel(days)}.`,
                      )
                    }
                  >
                    {daysLabel(days)}
                  </Button>
                ))}
              </span>
            }
          />
          <KVRow
            label="Credential"
            value={traces.hasCredential ? "Present" : "Not created yet"}
          />
          <KVRow
            label="Trace store"
            value={
              !traces.enabled ? "None" : traces.storeRunning ? "Running" : "Not started"
            }
          />
          <KVRow
            label="Size on disk"
            value={
              traces.storeSizeBytes === null ? (
                <Dash word="Unknown" />
              ) : (
                readBytes(traces.storeSizeBytes)
              )
            }
          />
        </KVList>
        <Note>
          A retention change applies only to spans sent after it; traces
          already kept keep the retention they arrived with.
        </Note>
        {serviceType === "compose" ? (
          <Note>
            Every service in this Compose sends to the one Trace store, each
            under its own service name unless the Compose file sets{" "}
            <code>OTEL_SERVICE_NAME</code> for it.
          </Note>
        ) : null}
        {!traces.enabled ? (
          <Note>
            Turning traces on takes effect at this Service&rsquo;s next
            deploy, which starts its Trace store.
          </Note>
        ) : null}
        {traces.enabled && !traces.storeRunning ? (
          <Note>
            Traces take effect at this Service&rsquo;s next deploy: that is
            when its Trace store starts and the Service is told where to send
            spans. Redeploy it to start.
          </Note>
        ) : null}
      </Card.Body>
    );
  }

  const cards = (
    <>
      <Card>
        <Card.Header
          title="Trace store"
          sub="Cloudgate hands a traced Service where to send spans and the credential to send them with at every deploy. It never instruments your code."
          headingLevel={2}
          actions={actions}
        />
        {body}
      </Card>
      {traces?.enabled && traces.storeRunning ? (
        <Card>
          <TraceStoreFrame serviceId={serviceId} />
        </Card>
      ) : null}
    </>
  );

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="Spans this Service sends over OpenTelemetry, kept in its own Trace store on its Server and readable by whoever can read the Service."
      />
      {aside ? (
        <Cols aside={aside.node} asideLabel={aside.label}>
          {cards}
        </Cols>
      ) : (
        cards
      )}
      <TeardownReportModal
        report={teardown.report}
        serviceName="This Service's Trace store"
        open={teardown.open}
        onOpenChange={teardown.setOpen}
        copy={{
          title: "Traces were turned off, but the Trace store was not all removed",
          description:
            "Cloudgate could not confirm it removed the Trace store's container or directory. They are listed below, on the machine that holds them.",
          footnote:
            "This list is not stored anywhere. Turning traces on and off again retries the removal.",
        }}
      />
    </Page>
  );
}
