import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { OperatorNamedOrganization } from "@/lib/api/endpoints/operator";
import type { OperatorAbuseReport } from "@/lib/api/endpoints/operator-abuse";
import { timeAgo, timeExact } from "@/lib/format/time";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import {
  useCloseAbuseReport,
  useForwardAbuseReport,
  useOpenAbuseReports,
} from "./use-operator-abuse";

/**
 * The Operator page's **open abuse reports** (ADR-0071, #1401): every report
 * an Operator forwarded and nobody closed yet, the nearest deadline first,
 * with the deadline and whether it has passed. A passed deadline suspends
 * nothing by itself: Suspend stays the Operator's own action on the
 * Organization's row. Close takes a report off once it is answered or acted
 * on. Rendered only for an Operator, inside `OperatorSection`.
 */
export function AbuseReportsCard() {
  const reports = useOpenAbuseReports(true);
  const close = useCloseAbuseReport();

  const arrival = useArrival(reports.isPending);
  if (reports.isPending) {
    return <SectionPending title="Abuse reports" rows={2} />;
  }
  if (reports.error) {
    return (
      <SectionFailed
        title="Abuse reports"
        error={reports.error}
        onRetry={() => void reports.refetch()}
      />
    );
  }

  async function closeReport(report: OperatorAbuseReport) {
    try {
      await close.mutateAsync(report.id);
      toast.done(`Closed the abuse report for ${report.organization.name}.`);
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <Card className={arrival}>
      <Card.Header
        title="Abuse reports"
        sub="Open until closed. Each was emailed to the Organization's owners and admins with 24 hours to answer; past it, decide whether to suspend."
        headingLevel={2}
      />
      <Card.Body flush>
        <DataTable
          label="Open abuse reports"
          rows={reports.data}
          columns={columnsFor(closeReport, close.isPending)}
          getRowId={(row) => row.id}
          rowName={(row) => row.organization.name}
          empty={
            <EmptyState icon="building" title="No open abuse reports">
              A report forwarded from an Organization&rsquo;s row stays here
              with its deadline until it is closed.
            </EmptyState>
          }
        />
      </Card.Body>
    </Card>
  );
}

/** "in 5 hours", or "Past deadline" once it has gone by. */
function deadlineCell(row: OperatorAbuseReport): React.ReactNode {
  const passed = Date.parse(row.deadlineAt) <= Date.now();
  return (
    <span className="inline-flex items-center gap-1.5">
      <time dateTime={row.deadlineAt} title={timeExact(row.deadlineAt)}>
        {timeExact(row.deadlineAt)}
      </time>
      {passed ? (
        <Chip variant="warn">Past deadline</Chip>
      ) : (
        <span className="text-tx-3">{timeAgo(row.deadlineAt)}</span>
      )}
    </span>
  );
}

function columnsFor(
  close: (row: OperatorAbuseReport) => Promise<void>,
  closing: boolean,
): Column<OperatorAbuseReport>[] {
  return [
    {
      id: "organization",
      head: "Organization",
      tone: "key",
      cell: (row) => row.organization.name,
    },
    {
      id: "deadline",
      head: "Deadline",
      cell: deadlineCell,
      compare: (a, b) => a.deadlineAt.localeCompare(b.deadlineAt),
    },
    {
      id: "report",
      head: "Report",
      truncate: true,
      cell: (row) => <span title={row.report}>{row.report}</span>,
    },
    {
      id: "forwarded-by",
      head: "Forwarded by",
      truncate: true,
      cell: (row) => row.forwardedBy ?? "—",
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      cell: (row) => (
        <Button
          type="button"
          size="xs"
          disabled={closing}
          onClick={() => void close(row)}
        >
          Close
        </Button>
      ),
    },
  ];
}

/** The backend's own bounds on a report (`forwardAbuseReportSchema`). */
const forwardSchema = z.object({
  report: z
    .string()
    .trim()
    .min(1, "Paste the report the customer should answer")
    .max(20_000, "A report is at most 20,000 characters"),
});
type ForwardValues = z.infer<typeof forwardSchema>;

/**
 * *Forward abuse report* on an Organization: the text goes word for word
 * to its owners and admins, with 24 hours to answer by replying, and is
 * written in its audit log. The provider's name must come out first, since
 * no customer is ever told who it is.
 */
export function ForwardAbuseReportModal({
  organization,
  open,
  onOpenChange,
}: {
  organization: OperatorNamedOrganization;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const forward = useForwardAbuseReport();
  const form = useApiForm<ForwardValues>({
    schema: forwardSchema,
    defaultValues: { report: "" },
    labelOf: (name) => (name === "report" ? "Report" : undefined),
    onSubmit: async ({ report }) => {
      await forward.mutateAsync({
        organizationId: organization.id,
        report: report.trim(),
      });
      toast.done(`Forwarded the abuse report to ${organization.name}.`);
      onOpenChange(false);
    },
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Forward an abuse report to ${organization.name}?`}
        description="Its owners and admins are emailed the report with 24 hours to answer, and it is recorded in its audit log. Nothing is suspended."
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <Field
              name="report"
              label="Report"
              hint="Sent word for word. Remove the provider's name and anything else that identifies it first."
            >
              <Textarea rows={8} />
            </Field>
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              Forward report
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
