import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { FormError } from "@/components/console/field";
import { LinkButton } from "@/components/console/link-button";
import { Modal } from "@/components/console/modal";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { PendingSetup } from "@/lib/api/endpoints/pending-setups";
import { usePermission } from "@/lib/auth/use-permission";
import { environmentPlanHref } from "@/lib/format/plan-href";
import { timeAgo, timeExact } from "@/lib/format/time";

import {
  PENDING_SETUP_CANCEL_REFUSAL,
  useCancelPendingSetup,
  usePendingSetups,
} from "./use-pending-setups";

/**
 * **The Environment's Pending setups** (ADR-0065): each Template setup here
 * whose parts no Apply has created yet, with Cancel, and the note each one
 * the 30-day sweep dropped leaves behind.
 *
 * **Nothing is rendered while there is nothing to say**: no Pending setup and
 * no note is the state of almost every Environment, and an empty card on all
 * of them would be a statement about a feature, not about this Environment.
 * A refusal or a failed read is still said, because it is not an empty list.
 *
 * **Rows, not a table.** A five-column table here was wider than the
 * Services column at desktop width and scrolled sideways, hiding Expires.
 * Each setup is a row whose facts wrap under its name, so nothing scrolls at
 * any width. The next step, the Environment's plan, is the card's one
 * button; Cancel setup is a quiet button on each row, because it is the
 * rarer and destructive choice.
 *
 * **Values are counted, never shown.** The route reports each as present
 * (ADR-0019), so the row says how many the setup holds; the plan says how
 * each one is made.
 *
 * **Cancel asks once**, in a dialog held at list level and keyed by the row
 * (rule 3.6): it drops secrets that cannot be made again, though the
 * template can be set up again. It is off with the reason for a role
 * without `environment: ['update']`, the statement the route asks.
 */
export function PendingSetupsCard({
  environmentId,
  projectId,
}: {
  environmentId: string;
  /** For the link to the Environment's plan; absent until the read lands. */
  projectId?: string;
}) {
  const list = usePendingSetups(environmentId);
  const cancel = useCancelPendingSetup(environmentId);
  const canCancel = usePermission({ environment: ["update"] });
  const [cancelling, setCancelling] = useState<PendingSetup | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (list.error) {
    return (
      <Card>
        <Card.Header title="Pending setups" />
        <Card.Body>
          <p className="text-body text-tx-2">{errorMessage(list.error)}</p>
        </Card.Body>
      </Card>
    );
  }
  if (list.isPending) {
    return (
      <Card aria-busy="true">
        <Card.Header title="Pending setups" />
        <Card.Body>
          <Skeleton className="h-row" />
        </Card.Body>
      </Card>
    );
  }
  const { pendingSetups, expired } = list.data;
  if (pendingSetups.length === 0 && expired.length === 0) return null;

  const planHref = projectId
    ? environmentPlanHref(projectId, environmentId)
    : null;

  return (
    <Card>
      <Card.Header
        title="Pending setups"
        sub="Waiting for an Apply to create their parts. Each is dropped after 30 days."
        actions={
          planHref && pendingSetups.length > 0 ? (
            <LinkButton href={planHref} size="sm">
              Review the plan
            </LinkButton>
          ) : null
        }
      />
      <Card.Body flush>
        {pendingSetups.length > 0 ? (
          <ul aria-label="Pending setups" className="divide-y divide-line">
            {pendingSetups.map((row) => (
              <li
                key={row.pendingSetupId}
                className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3"
              >
                <div className="min-w-0 grow basis-60">
                  <p className="text-body wrap-anywhere text-tx">
                    <span className="font-medium">{row.setupName}</span>
                    <span className="text-tx-3">
                      {" "}
                      · {row.templateName} template
                    </span>
                  </p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-meta text-tx-2">
                    <span className="inline-flex flex-wrap items-center gap-1">
                      Creates{" "}
                      {row.configNames.map((name) => (
                        <Chip key={name} variant="mono">
                          {name}
                        </Chip>
                      ))}
                    </span>
                    <span>{valuesLine(row)}</span>
                    <span title={timeExact(row.expiresAt)}>
                      Expires {timeAgo(row.expiresAt)}
                    </span>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="qt"
                  aria-disabled={canCancel.allowed ? undefined : true}
                  title={
                    canCancel.allowed ? undefined : PENDING_SETUP_CANCEL_REFUSAL
                  }
                  onClick={
                    canCancel.allowed
                      ? () => {
                          setRefusal(null);
                          setCancelling(row);
                        }
                      : undefined
                  }
                >
                  Cancel setup
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        {expired.length > 0 ? (
          <ul className="grid gap-1.5 border-t border-line px-4 py-3 text-body text-tx-2 first:border-t-0">
            {expired.map((note) => (
              <li key={note.expiredSetupId}>
                <strong className="font-medium text-tx">
                  {note.setupName}
                </strong>{" "}
                ({note.templateName} template) was dropped{" "}
                <span title={timeExact(note.expiredAt)}>
                  {timeAgo(note.expiredAt)}
                </span>
                , 30 days after it was set up, with no Apply having created{" "}
                <span className="font-mono">{note.configNames.join(", ")}</span>
                . Its values are gone; set the template up again to use it.
              </li>
            ))}
          </ul>
        ) : null}
      </Card.Body>

      <Modal
        key={cancelling?.pendingSetupId ?? "none"}
        open={cancelling !== null}
        onOpenChange={(next) => {
          if (!next) setCancelling(null);
        }}
      >
        {cancelling ? (
          <>
            <Modal.Header
              title={`Cancel the ${cancelling.setupName} setup?`}
              description="Cancel setup drops its Pending setup and every value it made."
            />
            <Modal.Body>
              <p className="text-body wrap-anywhere text-tx-2">
                The plan will no longer create{" "}
                <span className="font-mono">
                  {cancelling.configNames.join(", ")}
                </span>
                , and generated values cannot be made again. You can set the{" "}
                {cancelling.templateName} template up again at any time.
              </p>
              <FormError message={refusal ?? undefined} />
            </Modal.Body>
            <Modal.Footer>
              <Modal.Gap />
              <Modal.Close render={<Button type="button">Keep it</Button>} />
              <Button
                type="button"
                variant="dngr"
                disabled={cancel.isPending}
                aria-busy={cancel.isPending || undefined}
                onClick={() => {
                  setRefusal(null);
                  cancel.mutate(cancelling.pendingSetupId, {
                    onSuccess: () => {
                      toast.done(`${cancelling.setupName} setup cancelled.`);
                      setCancelling(null);
                    },
                    onError: (error) => setRefusal(errorMessage(error)),
                  });
                }}
              >
                Cancel setup
              </Button>
            </Modal.Footer>
          </>
        ) : null}
      </Modal>
    </Card>
  );
}

/**
 * "2 values ready": a count, never a value. They are kept encrypted until
 * Apply (ADR-0019); the plan says how each one is made.
 */
function valuesLine(row: PendingSetup): string {
  const held = row.values.filter((value) => value.hasValue).length;
  if (held === 0) return "No values";
  return `${held} ${held === 1 ? "value" : "values"} ready`;
}
