"use client";

import { notFound } from "next/navigation";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { RowTime } from "@/components/console/rows/cells";
import { Button } from "@/components/ui/button";
import { formatDay, PLAN_LABELS } from "@/lib/api/endpoints/billing";
import type {
  OperatorCount,
  OperatorOrganization,
  OperatorPlan,
  OperatorState,
} from "@/lib/api/endpoints/operator";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { AbuseReportsCard, ForwardAbuseReportModal } from "./abuse-reports";
import { BoughtServersSection } from "./bought-servers-section";
import { EnterpriseModal } from "./enterprise-modal";
import { OrphanMachinesSection } from "./orphan-machines-section";
import {
  LiftSuspensionModal,
  SuspendOrganizationModal,
} from "./suspension-modals";
import { useIsOperator, useOperatorOrganizations } from "./use-operator";

/** Which write the Operator opened, on which Organization. */
type Acting = {
  kind: "suspend" | "lift" | "enterprise" | "abuse";
  organization: OperatorOrganization;
};

/**
 * The Operator page (ADR-0050): every Organization on the Hosted
 * instance, with its account facts — name, created, owner, members, Plan,
 * a plain State and whether its free trial is used, Servers and Cloud
 * Environments used against its counts, and Enterprise. The list stays flat
 * (ADR-0059): an Attached Organization is a row of its own, "Paid by" its
 * Paying Organization, and nothing here attaches, detaches or re-points one. Nothing from inside a Project, because the API sends nothing
 * from there. Each row can be suspended with a reason, or lifted,
 * and switched to Enterprise with its counts, or back.
 *
 * **There is no such page for anybody else.** Self-hosted, or for a person
 * who is not an Operator, it is the console's not-found screen, the same as
 * an address that names nothing: the settings list does not offer it either.
 *
 * Under the Organizations, the **Bought Servers** section (#1399): the Server
 * markup and margin floor, and every Bought Server with its real margin.
 *
 * Each row can also be sent an abuse report (#1401), and the open ones
 * are listed with their deadlines between the two.
 */
export function OperatorSection() {
  const { operator, pending } = useIsOperator();
  const organizations = useOperatorOrganizations(operator);
  const [acting, setActing] = useState<Acting | null>(null);

  const arrival = useArrival(pending || organizations.isPending);
  if (pending) return <SectionPending title="Organizations" rows={4} />;
  if (!operator) notFound();

  if (organizations.isPending) {
    return <SectionPending title="Organizations" rows={4} />;
  }
  if (organizations.error) {
    return (
      <SectionFailed
        title="Organizations"
        error={organizations.error}
        onRetry={() => void organizations.refetch()}
      />
    );
  }

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      <OrganizationsCard
        organizations={organizations.data}
        acting={acting}
        setActing={setActing}
      />
      <AbuseReportsCard />
      <BoughtServersSection />
      <OrphanMachinesSection />
    </div>
  );
}

function OrganizationsCard({
  organizations,
  acting,
  setActing,
}: {
  organizations: OperatorOrganization[];
  acting: Acting | null;
  setActing: (acting: Acting | null) => void;
}) {
  return (
    <Card>
      <Card.Header
        title="Organizations"
        sub="Account facts only. Supporting a customer inside their Projects means being invited as a member."
        headingLevel={2}
      />
      <Card.Body flush>
        <DataTable
          label="Organizations on this instance"
          rows={organizations}
          columns={columnsFor(setActing)}
          getRowId={(row) => row.id}
          rowName={(row) => row.name}
          defaultSort={{ id: "created", dir: "asc" }}
          empty={
            <EmptyState icon="building" title="No Organizations yet">
              Every Organization on this instance is listed here once it is
              created.
            </EmptyState>
          }
        />
      </Card.Body>
      {acting?.kind === "suspend" ? (
        <SuspendOrganizationModal
          organization={acting.organization}
          open
          onOpenChange={(open) => !open && setActing(null)}
        />
      ) : null}
      {acting?.kind === "enterprise" ? (
        <EnterpriseModal
          organization={acting.organization}
          open
          onOpenChange={(open) => !open && setActing(null)}
        />
      ) : null}
      {acting?.kind === "abuse" ? (
        <ForwardAbuseReportModal
          organization={acting.organization}
          open
          onOpenChange={(open) => !open && setActing(null)}
        />
      ) : null}
      {acting?.kind === "lift" ? (
        <LiftSuspensionModal
          organization={acting.organization}
          open
          onOpenChange={(open) => !open && setActing(null)}
        />
      ) : null}
    </Card>
  );
}

function columnsFor(
  act: (acting: Acting) => void,
): Column<OperatorOrganization>[] {
  return [...COLUMNS, standingColumn, actionsColumn(act)];
}

/** "Suspended" with the reason the customer sees, or a dash. */
const standingColumn: Column<OperatorOrganization> = {
  id: "suspension",
  head: "Suspension",
  truncate: true,
  cell: (row) =>
    row.suspension ? (
      <span
        className="inline-flex items-center gap-1.5"
        title={row.suspension.reason}
      >
        <Chip>Suspended</Chip>
        {row.suspension.reason}
      </span>
    ) : (
      "None"
    ),
};

function actionsColumn(
  act: (acting: Acting) => void,
): Column<OperatorOrganization> {
  return {
    id: "actions",
    head: <span className="sr-only">Actions</span>,
    cell: (row) => (
      <span className="inline-flex items-center gap-1.5">
        <Button
          type="button"
          size="xs"
          onClick={() => act({ kind: "abuse", organization: row })}
        >
          Forward abuse report
        </Button>
        <Button
          type="button"
          size="xs"
          onClick={() => act({ kind: "enterprise", organization: row })}
        >
          Enterprise
        </Button>
        {row.suspension ? (
          <Button
            type="button"
            size="xs"
            onClick={() => act({ kind: "lift", organization: row })}
          >
            Lift suspension
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="dngr"
            onClick={() => act({ kind: "suspend", organization: row })}
          >
            Suspend
          </Button>
        )}
      </span>
    ),
  };
}

const COLUMNS: Column<OperatorOrganization>[] = [
  {
    id: "name",
    head: "Organization",
    tone: "key",
    cell: (row) => row.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    id: "created",
    head: "Created",
    cell: (row) => <RowTime iso={row.createdAt} />,
    compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
  },
  {
    id: "owner",
    head: "Owner",
    truncate: true,
    cell: (row) => <span title={row.ownerEmail}>{row.ownerEmail}</span>,
    compare: (a, b) => a.ownerEmail.localeCompare(b.ownerEmail),
  },
  {
    id: "members",
    head: "Members",
    tone: "num",
    cell: (row) => row.memberCount,
    compare: (a, b) => a.memberCount - b.memberCount,
  },
  {
    id: "plan",
    head: "Plan",
    cell: (row) => planCellOf(row),
    compare: (a, b) => planCellOf(a).localeCompare(planCellOf(b)),
  },
  {
    id: "state",
    head: "State",
    cell: (row) => stateLabelOf(row.state),
  },
  {
    id: "trial-used",
    head: "Trial used",
    cell: (row) => (row.trialUsed ? "Yes" : "No"),
  },
  {
    id: "servers",
    head: "Servers",
    tone: "num",
    cell: (row) => usedOf(row, row.servers),
    compare: (a, b) => a.servers.used - b.servers.used,
  },
  {
    id: "cloud-environments",
    head: "Cloud Environments",
    tone: "num",
    cell: (row) => usedOf(row, row.cloudEnvironments),
    compare: (a, b) => a.cloudEnvironments.used - b.cloudEnvironments.used,
  },
  {
    id: "enterprise",
    head: "Enterprise",
    cell: (row) => (row.enterprise ? "Yes" : "No"),
  },
];

/**
 * The Plan cell (ADR-0059): "Paid by <Paying Organization>" for an Attached
 * Organization, "Business, pays for N" for a Paying one, else its plan.
 */
function planCellOf(row: OperatorOrganization): string {
  if (row.paidBy) return `Paid by ${row.paidBy.name}`;
  const plan = planLabelOf(row.plan);
  return row.attached.length > 0
    ? `${plan}, pays for ${row.attached.length}`
    : plan;
}

/** Starter, Business, Enterprise, or None. */
function planLabelOf(plan: OperatorPlan | null): string {
  if (!plan) return "None";
  return plan === "enterprise" ? "Enterprise" : PLAN_LABELS[plan];
}

/** The State in plain words, never a Stripe status. */
function stateLabelOf(state: OperatorState): string {
  switch (state.kind) {
    case "trial":
      return `Trial, ends ${formatDay(state.endsAt)}`;
    case "ends":
      return `Ends on ${formatDay(state.endsAt)}`;
    case "moves-to-starter":
      return `Moves to Starter on ${formatDay(state.on)}`;
    case "paid":
      return "Paid";
    case "payment-failing":
      return "Payment failing";
    case "lapsed":
      return "Lapsed";
    case "suspended":
      return "Suspended";
    case "none":
      return "None";
  }
}

/**
 * What it holds against what it may hold. An Attached Organization's is its
 * own share against its Paying Organization's whole pool, "2 of Acme's 10";
 * a Paying Organization's counts are already the whole pool's.
 */
function usedOf(row: OperatorOrganization, count: OperatorCount): string {
  return row.paidBy
    ? `${count.used} of ${row.paidBy.name}'s ${count.allowed}`
    : `${count.used} of ${count.allowed}`;
}
