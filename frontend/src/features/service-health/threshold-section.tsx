import { useState } from "react";

import { Card } from "@/components/console/card";
import { DeleteResourceModal } from "@/components/console/delete-resource-modal";
import { EmptyState } from "@/components/console/empty-state";
import { KVList, KVRow } from "@/components/console/kv-list";
import { ResourceFormModal } from "@/components/console/resource-form-modal";
import { Skeleton } from "@/components/console/skeleton";
import { StatusPill } from "@/components/console/status-pill";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ServiceType } from "@/lib/api/endpoints/applications";
import type {
  ErrorRate,
  ErrorRateThreshold,
  ServiceHealth,
} from "@/lib/api/endpoints/service-health";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import type { Mark } from "@/lib/design/status";
import { useServiceHealth } from "@/lib/api/use-service-health";

import { errorRateThresholdSpec } from "./error-rate-threshold-spec";
import { minutesLabel, requestsLabel, thresholdWords } from "./health-words";
import { useThresholdMutations } from "./use-service-health";

/** The two slices this section reads. Module-level, so `select` memoises. */
const thresholdOf = (
  health: ServiceHealth,
): { threshold: ErrorRateThreshold | null; errorRate: ErrorRate } => ({
  threshold: health.errorRateThreshold,
  errorRate: health.errorRate,
});

/** What the threshold is doing now, as one mark. */
export function thresholdMark(
  threshold: Pick<ErrorRateThreshold, "enabled">,
  errorRate: Pick<ErrorRate, "available">,
): Mark {
  if (!threshold.enabled) return { glyph: "⊘", tone: "mute", label: "off" };
  if (!errorRate.available) {
    return { glyph: "○", tone: "mute", label: "not judged yet" };
  }
  return { glyph: "●", tone: "ok", label: "judged" };
}

/**
 * **The Health tab's Error-rate threshold** — the fourth section, under
 * the Error rate: the Service's one standing condition on its Error rate, a
 * percentage over a trailing window, judged only when the window holds enough
 * requests. A breach opens the same Incident a failing Uptime check does, and
 * it shows in the banner and the history above and below.
 *
 * **A Service has at most one**, so this is facts and three buttons rather
 * than a list: Add a threshold when there is none; Edit, Turn off / Turn on
 * and Remove when there is one. Each is off, with the reason, for a role
 * without `service: ['update']` — the same statement every write takes.
 *
 * **A threshold can be added before there is an Error rate** (user story 62),
 * and then says it is not judged yet and why — the Error rate's own reason.
 * **A database cannot have one** and says so, with no button.
 *
 * It reads the summary's `errorRateThreshold` and `errorRate` through the
 * panel's cache entry (`page`), never a request of its own.
 */
export function ThresholdSection({
  serviceType,
  serviceId,
  page,
}: {
  serviceType: ServiceType;
  serviceId: string;
  page: number;
}) {
  if (serviceType !== "application" && serviceType !== "compose") {
    return (
      <ThresholdCard>
        <Card.Body>
          <EmptyState icon="gauge" title="Databases have no Error-rate threshold">
            A threshold judges the Error rate, and a database has none: it is
            not reached through a Domain Traefik counts requests for.
          </EmptyState>
        </Card.Body>
      </ThresholdCard>
    );
  }
  return (
    <ServiceThreshold serviceType={serviceType} serviceId={serviceId} page={page} />
  );
}

function ThresholdCard({
  actions,
  children,
}: {
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <Card.Header
        title="Error-rate threshold"
        sub="Opens an Incident when too many of this Service's requests fail."
        headingLevel={2}
        actions={actions}
      />
      {children}
    </Card>
  );
}

function ServiceThreshold({
  serviceType,
  serviceId,
  page,
}: {
  serviceType: ServiceType;
  serviceId: string;
  page: number;
}) {
  const read = useServiceHealth(serviceType, serviceId, page, thresholdOf);
  const mutations = useThresholdMutations(serviceType, serviceId);
  const canUpdate = usePermission({ service: ["update"] });
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState(0);
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);

  const spec = errorRateThresholdSpec({
    put: (input) => mutations.put.mutateAsync(input),
    remove: () => mutations.remove.mutateAsync(),
  });
  const threshold = read.data?.threshold ?? null;
  const errorRate = read.data?.errorRate;

  async function setEnabled(row: ErrorRateThreshold, enabled: boolean) {
    try {
      await mutations.put.mutateAsync({
        percentage: row.percentage,
        windowMinutes: row.windowMinutes,
        minRequests: row.minRequests,
        enabled,
      });
      toast.done(
        enabled ? "Error-rate threshold turned on." : "Error-rate threshold turned off.",
      );
    } catch (error) {
      toast.error(error);
    }
  }

  const addThreshold = (
    <Button
      size="sm"
      variant="pri"
      disabled={!canUpdate.allowed}
      title={canUpdate.allowed ? undefined : roleRefusal("add a threshold")}
      onClick={() => {
        if (!canUpdate.allowed) return;
        setOpening((n) => n + 1);
        setAdding(true);
      }}
    >
      Add a threshold
    </Button>
  );

  let body: React.ReactNode;
  let actions: React.ReactNode = null;
  if (read.error && !read.data) {
    body = (
      <Card.Body>
        <p className="text-body text-tx-2">{errorMessage(read.error)}</p>
      </Card.Body>
    );
  } else if (!read.data || !errorRate) {
    body = (
      <Card.Body>
        <div className="grid gap-2.5" aria-busy="true">
          <Skeleton className="h-row" />
          <Skeleton className="h-row" />
        </div>
      </Card.Body>
    );
  } else if (!threshold) {
    body = (
      <Card.Body>
        <EmptyState icon="gauge" title="No threshold" action={addThreshold}>
          {/* It catches a Service whose health endpoint still answers 200,
              and tells the notification channels once on open and once on
              close. */}
          Add a threshold to open an Incident when too many of this
          Service&rsquo;s requests answer 5xx over a window.
          {errorRate.available
            ? null
            : ` It can be added now and is judged once there is an Error rate (${errorRate.message}).`}
        </EmptyState>
      </Card.Body>
    );
  } else {
    const updateRefusal = (action: string) =>
      canUpdate.allowed ? undefined : roleRefusal(action);
    actions = (
      <span className="inline-flex gap-1.5">
        <Button
          size="sm"
          disabled={!canUpdate.allowed || mutations.put.isPending}
          title={updateRefusal(
            threshold.enabled ? "turn this threshold off" : "turn this threshold on",
          )}
          onClick={() =>
            canUpdate.allowed && setEnabled(threshold, !threshold.enabled)
          }
        >
          {threshold.enabled ? "Turn off" : "Turn on"}
        </Button>
        <Button
          size="sm"
          disabled={!canUpdate.allowed}
          title={updateRefusal("change this threshold")}
          onClick={() => canUpdate.allowed && setEditing(true)}
        >
          Edit
        </Button>
        <Button
          size="sm"
          variant="dngr"
          disabled={!canUpdate.allowed}
          title={updateRefusal("remove this threshold")}
          onClick={() => canUpdate.allowed && setRemoving(true)}
        >
          Remove
        </Button>
      </span>
    );
    body = (
      <Card.Body className="grid gap-3">
        <KVList>
          <KVRow label="Opens an Incident at" value={thresholdWords(threshold)} />
          <KVRow
            label="Judged when"
            value={`At least ${requestsLabel(threshold.minRequests)} in ${minutesLabel(threshold.windowMinutes)}`}
          />
          <KVRow
            label="State"
            value={<StatusPill mark={thresholdMark(threshold, errorRate)} />}
          />
        </KVList>
        {threshold.enabled && !errorRate.available ? (
          <p className="inline-flex items-start gap-1.5 text-meta text-tx-2">
            <Icon name="info" size={14} />
            <span>
              Not judged yet: {errorRate.message}. It is judged at every
              collection once there is an Error rate.
            </span>
          </p>
        ) : null}
      </Card.Body>
    );
  }

  return (
    <>
      <ThresholdCard actions={actions}>{body}</ThresholdCard>
      <ResourceFormModal
        key={`add-${opening}`}
        spec={spec}
        row={null}
        open={adding}
        onOpenChange={setAdding}
      />
      <ResourceFormModal
        key={threshold ? `edit-${threshold.errorRateThresholdId}-${String(editing)}` : "none"}
        spec={spec}
        row={editing ? threshold : null}
        open={editing && threshold !== null}
        onOpenChange={setEditing}
      />
      <DeleteResourceModal
        spec={spec}
        row={removing ? threshold : null}
        open={removing && threshold !== null}
        onOpenChange={setRemoving}
      />
    </>
  );
}
