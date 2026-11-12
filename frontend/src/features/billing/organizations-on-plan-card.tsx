import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { RowSub } from "@/components/console/rows/cells";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AttachedOrganization, Usage } from "@/lib/api/endpoints/billing";
import { sentence } from "@/lib/api/error-message";
import {
  useAddOrganizationToPlan,
  useAttachedOrganizations,
} from "@/lib/api/use-billing";
import {
  roleRefusal,
  usePermission,
  type Gate,
} from "@/lib/auth/use-permission";
import { fullName, personName } from "@/lib/format/person";
import { counted } from "@/lib/format/plural";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { StopPayingConfirm } from "./stop-paying-confirm";

/**
 * **"Organizations on this plan"** (ADR-0059): the Organizations this one
 * pays for, and "Add an Organization to this plan", for its owners and admins.
 *
 * ## A refused add is greyed out, never hidden
 *
 * On Starter, with no plan, while a move to Starter waits, or from an
 * Organization that is attached itself, the button stays on the card, greyed
 * out, with the backend's own sentence under it — the one
 * `POST /organizations` would refuse with (`ORGANIZATION_LIMIT`), read off
 * `GET /billing/attached-organizations` so the two never disagree.
 *
 * ## A plain table
 *
 * Name, owner, Servers, Cloud Environments and the date it was made, and
 * last "Stop paying for it", which asks first (`StopPayingConfirm`).
 *
 * The whole Billing page is an owner's or admin's read, so nobody else ever
 * sees the card or its row action; the route asks again. Both still read
 * `organization: ['update']` (`gated-controls.ts`): the add and the detach
 * admit the Paying Organization's owners and admins only — the open
 * Organization's, who both hold it.
 */
export function OrganizationsOnPlanCard() {
  const attached = useAttachedOrganizations();
  const canManage = usePermission({ organization: ["update"] });
  const [adding, setAdding] = useState(false);
  const [stopping, setStopping] = useState<AttachedOrganization | null>(null);

  const arrival = useArrival(attached.isPending);
  if (attached.isPending) {
    return <SectionPending title="Organizations on this plan" rows={2} />;
  }
  if (attached.error) {
    return (
      <SectionFailed
        title="Organizations on this plan"
        error={attached.error}
        onRetry={() => void attached.refetch()}
      />
    );
  }

  const { allowed, reason, free, organizations } = attached.data;

  return (
    <Card className={arrival}>
      <Card.Header
        title="Organizations on this plan"
        sub="Organizations this plan pays for. Each has its own members, and they all share its Servers and Cloud Environments."
        headingLevel={2}
        actions={
          <Button
            type="button"
            size="sm"
            disabled={!canManage.allowed || !allowed}
            title={canManage.allowed ? undefined : ADD_REFUSAL}
            onClick={() => setAdding(true)}
          >
            Add an Organization to this plan
          </Button>
        }
      />
      {!allowed && reason ? (
        <p className="border-b border-line px-4 py-2.75 text-meta text-tx-3">
          {sentence(reason)}
        </p>
      ) : null}
      <DataTable
        label="Organizations on this plan"
        columns={columnsWith(setStopping, {
          allowed: canManage.allowed,
          refusal: STOP_PAYING_REFUSAL,
        })}
        rows={organizations}
        getRowId={(row) => row.id}
        empty={
          <EmptyState icon="layers" title="No other Organizations on this plan">
            Add an Organization to this plan to share its Servers and Cloud
            Environments with it.
          </EmptyState>
        }
      />
      {adding ? (
        <AddToPlanModal free={free} open onOpenChange={setAdding} />
      ) : null}
      {stopping ? (
        <StopPayingConfirm
          organization={stopping}
          open
          onOpenChange={(open) => {
            if (!open) setStopping(null);
          }}
        />
      ) : null}
    </Card>
  );
}

const ADD_REFUSAL = roleRefusal("add an Organization to this plan");
const STOP_PAYING_REFUSAL = roleRefusal("stop paying for an Organization");

/** "12 March 2026": the day it was made, with its year. */
function madeOn(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** The table's columns, "Stop paying for it" last, opening its confirm. */
const columnsWith = (
  onStopPaying: (row: AttachedOrganization) => void,
  stopPaying: Gate,
): Column<AttachedOrganization>[] => [
  {
    id: "name",
    head: "Organization",
    tone: "key",
    cell: (row) => row.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    id: "owner",
    head: "Owner",
    cell: (row) =>
      row.owner ? (
        <span className="block min-w-0">
          {personName(row.owner)}
          {fullName(row.owner) ? <RowSub>{row.owner.email}</RowSub> : null}
        </span>
      ) : (
        <span className="text-tx-3">Gone</span>
      ),
  },
  {
    id: "servers",
    head: "Servers",
    tone: "num",
    cell: (row) => row.servers,
  },
  {
    id: "cloudEnvironments",
    head: "Cloud Environments",
    tone: "num",
    cell: (row) => row.cloudEnvironments,
  },
  {
    id: "createdAt",
    head: "Made",
    tone: "muted",
    cell: (row) => madeOn(row.createdAt),
    compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
  },
  {
    id: "stopPaying",
    head: <span className="sr-only">Actions</span>,
    className: "w-0",
    cell: (row) => (
      <span className="inline-flex justify-end whitespace-nowrap">
        <Button
          size="xs"
          variant="dngr"
          disabled={!stopPaying.allowed}
          title={stopPaying.allowed ? undefined : stopPaying.refusal}
          onClick={() => onStopPaying(row)}
        >
          Stop paying for it
        </Button>
      </span>
    ),
  },
];

/** The DTO's bounds (`createOrganizationSchema`), in the console's words. */
const schema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Name the Organization.")
    .max(255, "A name is at most 255 characters."),
});
type Values = z.infer<typeof schema>;

/**
 * "Add an Organization to this plan": a new Organization this one pays for.
 * It says how much of the shared pool is free, since the new Organization's
 * Servers and Cloud Environments come out of it.
 */
function AddToPlanModal({
  free,
  open,
  onOpenChange,
}: {
  free: Usage;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const add = useAddOrganizationToPlan();
  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: "" },
    onSubmit: async ({ name }) => {
      await add.mutateAsync(name);
      toast.done(`${name} created. This plan pays for it, and you own it.`);
      onOpenChange(false);
    },
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Add an Organization to this plan"
        description="You will be its owner, and it starts with its own members: only you. You stay where you are."
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <p className="text-body text-tx-2">
              {counted(free.servers, "Server", "Servers")} and{" "}
              {counted(
                free.cloudEnvironments,
                "Cloud Environment",
                "Cloud Environments",
              )}{" "}
              are free on this plan. The new Organization shares them with every
              Organization on it.
            </p>
            <Field
              name="name"
              label="Name"
              hint="What it is called everywhere in the console."
            >
              <Input autoComplete="off" />
            </Field>
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              Add Organization
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
