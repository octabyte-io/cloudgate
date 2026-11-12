"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/console/modal";
import {
  TeardownReportPanel,
  type TeardownReportPanelCopy,
} from "@/components/console/teardown-report";
import {
  teardownReportIsEmpty,
  type TeardownReport,
} from "@/lib/api/endpoints/teardown";

/**
 * The report a delete answered with, in a dialog the operator has to dismiss.
 *
 * **Why a second modal rather than the delete dialog staying open.** The delete
 * dialog is a `ConfirmDeleteModal`: it holds a type-the-name field and a
 * `dngr` button, and leaving those on screen after the row is gone offers an
 * action that would now 404. So the confirm closes, and this opens in its
 * place — the same beat, a different question. It is also why this one has no
 * destructive control at all: everything left to do is on a machine, not here.
 *
 * **It cannot be dismissed by clicking away** (`keepOpen`). Losing this to a
 * stray click loses the only copy of the paths, which is the failure the whole
 * feature exists to prevent.
 */
export function TeardownReportModal({
  report,
  serviceName,
  open,
  onOpenChange,
  onDismissed,
  copy,
}: {
  report: TeardownReport | undefined;
  /** The thing that was deleted, for the title. Its row no longer exists. */
  serviceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs once the operator dismisses — where the caller navigates away. */
  onDismissed?: () => void;
  /**
   * Wording for a report that is not a delete's — see
   * {@link TeardownReportPanelCopy}. An omitted sentence keeps the delete's.
   */
  copy?: {
    title?: string;
    description?: string;
    footnote?: string;
    panel?: TeardownReportPanelCopy;
  };
}) {
  if (teardownReportIsEmpty(report)) return null;

  return (
    <Modal open={open} onOpenChange={onOpenChange} keepOpen>
      <Modal.Header
        title={
          copy?.title ??
          `${serviceName} was deleted, but not everything was cleaned up`
        }
        description={
          copy?.description ??
          "Cloudgate could not confirm it removed all of this service's artifacts. They are listed below, on the machines that still hold them."
        }
      />
      <Modal.Body>
        <TeardownReportPanel report={report} copy={copy?.panel} />
        <p className="text-meta text-tx-3">
          {copy?.footnote ??
            "This list is not stored anywhere. The service’s row has been deleted, so once you close this it cannot be shown again."}
        </p>
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Button
          onClick={() => {
            onOpenChange(false);
            onDismissed?.();
          }}
        >
          I have a copy of this
        </Button>
      </Modal.Footer>
    </Modal>
  );
}

/**
 * Sequencing for a delete that can answer with one of these.
 *
 * The caller runs its delete through {@link runDelete}. On a clean teardown
 * that resolves to `true` and the caller closes and navigates exactly as it
 * did before this existed; on a report it resolves to `false`, and the caller
 * closes its confirm dialog but defers navigating until `onDismissed` fires,
 * because the report is anchored to a screen the navigation would unmount.
 *
 * Written as a hook rather than left to each call site because the ordering is
 * the part that is easy to get wrong, and getting it wrong silently drops the
 * report — which is exactly the defect being fixed.
 */
export function useTeardownReport() {
  const [report, setReport] = React.useState<TeardownReport | undefined>();
  const [open, setOpen] = React.useState(false);

  const runDelete = React.useCallback(
    async (remove: () => Promise<TeardownReport>) => {
      const answered = await remove();
      if (teardownReportIsEmpty(answered)) return true;
      setReport(answered);
      setOpen(true);
      return false;
    },
    [],
  );

  return { report, open, setOpen, runDelete };
}
