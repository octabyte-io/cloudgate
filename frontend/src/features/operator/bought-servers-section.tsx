import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable, type Column } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { Field, FormError } from "@/components/console/field";
import { RowTime } from "@/components/console/rows/cells";
import { Segmented } from "@/components/console/segmented";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDay, formatMoney } from "@/lib/api/endpoints/billing";
import type { BoughtServerStage } from "@/lib/api/endpoints/bought-servers";
import type {
  BoughtServerSettings,
  OperatorBoughtServer,
  OperatorBoughtServers,
} from "@/lib/api/endpoints/operator";

import { SectionFailed, SectionPending } from "../settings/section-states";
import { PowerModal, powerColumn, type Powering } from "./power-off";
import { RepriceModal } from "./reprice-modal";
import {
  useBoughtServerSettings,
  useOperatorBoughtServers,
  useSetBoughtServerSettings,
} from "./use-operator";
import { useArrival } from "@/components/console/use-arrival";

/** How each stage reads on the Operator page. */
export const STAGE_LABELS: Record<BoughtServerStage, string> = {
  waiting_for_payment: "Waiting for payment",
  creating: "Creating",
  setting_up: "Setting up",
  ready: "Ready",
  changing: "Changing",
  deleting: "Deleting",
  deleted: "Deleted",
  failed: "Failed",
};

type Shown = "all" | "below-floor";

/**
 * The Operator page's **Bought Servers** section (spec #1387, #1399): the
 * Server markup and the margin floor, then every Bought Server with its real
 * margin, the price less the provider's EUR cost at the day's rate, flagged
 * under the floor and filterable to those. Account facts only (ADR-0050):
 * nothing here reaches a machine. Rendered only for an Operator, inside
 * `OperatorSection`.
 */
export function BoughtServersSection() {
  return (
    <>
      <BoughtServerSettingsCard />
      <BoughtServersCard />
    </>
  );
}

function BoughtServerSettingsCard() {
  const settings = useBoughtServerSettings(true);

  if (settings.isPending) {
    return <SectionPending title="Server markup" rows={2} />;
  }
  if (settings.error) {
    return (
      <SectionFailed
        title="Server markup"
        error={settings.error}
        onRetry={() => void settings.refetch()}
      />
    );
  }
  // Keyed on what is stored, so a save elsewhere resets the fields.
  return (
    <SettingsForm
      key={`${settings.data.markupPercent}-${settings.data.marginFloorPercent}`}
      settings={settings.data}
    />
  );
}

const PERCENT = /^\d+$/;
const schema = z.object({
  markupPercent: z
    .string()
    .trim()
    .regex(PERCENT, "A whole percent, 0 or more")
    .refine((value) => Number(value) <= 1000, "At most 1000%"),
  marginFloorPercent: z
    .string()
    .trim()
    .regex(PERCENT, "A whole percent, 0 or more")
    .refine((value) => Number(value) <= 100, "At most 100%"),
});
type Values = z.infer<typeof schema>;

const LABELS: Record<string, string> = {
  markupPercent: "Server markup",
  marginFloorPercent: "Margin floor",
};

function SettingsForm({ settings }: { settings: BoughtServerSettings }) {
  const save = useSetBoughtServerSettings();
  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      markupPercent: String(settings.markupPercent),
      marginFloorPercent: String(settings.marginFloorPercent),
    },
    labelOf: (name) => LABELS[name],
    onSubmit: async (values) => {
      await save.mutateAsync({
        markupPercent: Number(values.markupPercent),
        marginFloorPercent: Number(values.marginFloorPercent),
      });
      toast.done("The Server markup and margin floor are saved.");
    },
  });

  return (
    <Card>
      <Card.Header
        title="Server markup"
        sub="What Bought Servers are priced at over the provider's list, and the margin under which one is flagged. Never shown to customers."
        headingLevel={2}
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Card.Body className="grid gap-3.5">
            {settings.reverseDnsDomain ? null : (
              <p
                role="status"
                className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-body text-tx"
              >
                The reverse-DNS domain is not set, so each machine keeps the
                provider&rsquo;s default reverse DNS name, which names the
                provider. Set BOUGHT_SERVER_REVERSE_DNS_DOMAIN to an Octabyte
                domain.
              </p>
            )}
            <Field
              name="markupPercent"
              label="Server markup, in percent"
              hint="Prices new purchases and new lines only: every line already sold keeps its price."
            >
              <Input type="number" min={0} max={1000} step={1} />
            </Field>
            <Field
              name="marginFloorPercent"
              label="Margin floor, in percent"
              hint="A Bought Server whose margin is under this share of its price is flagged below."
            >
              <Input type="number" min={0} max={100} step={1} />
            </Field>
            <FormError message={form.rootError} />
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <SubmitButton pending={form.formState.isSubmitting}>
                Save changes
              </SubmitButton>
            </div>
          </Card.Body>
          <Card.Footer>
            Each change is recorded in the Instance organization&rsquo;s audit
            log.
          </Card.Footer>
        </form>
      </FormProvider>
    </Card>
  );
}

function BoughtServersCard() {
  const list = useOperatorBoughtServers(true);
  const [shown, setShown] = useState<Shown>("all");
  const [powering, setPowering] = useState<Powering | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  // Each opening is its own key, so the preview is asked afresh.
  const [repricing, setRepricing] = useState<number | null>(null);

  const arrival = useArrival(list.isPending);
  if (list.isPending) return <SectionPending title="Bought Servers" rows={3} />;
  if (list.error) {
    return (
      <SectionFailed
        title="Bought Servers"
        error={list.error}
        onRetry={() => void list.refetch()}
      />
    );
  }

  const below = list.data.servers.filter((server) => server.belowFloor);
  const rows = shown === "below-floor" ? below : list.data.servers;

  return (
    <Card className={arrival}>
      <Card.Header
        title="Bought Servers"
        sub={rateSentence(list.data)}
        headingLevel={2}
        actions={
          <>
            <Segmented<Shown>
              label="Which Bought Servers to show"
              value={shown}
              onChange={(next) => {
                // The table is remade for the other list, its ticks with it.
                setShown(next);
                setChosen([]);
              }}
              options={[
                { value: "all", label: `All (${list.data.servers.length})` },
                {
                  value: "below-floor",
                  label: `Below floor (${below.length})`,
                },
              ]}
            />
            <Button
              type="button"
              aria-disabled={chosen.length === 0 || undefined}
              title={
                chosen.length === 0
                  ? "Choose the Bought Servers to reprice"
                  : undefined
              }
              onClick={() => {
                if (chosen.length > 0) setRepricing(Date.now());
              }}
            >
              {`Reprice chosen (${chosen.length})`}
            </Button>
          </>
        }
      />
      <Card.Body flush>
        <DataTable
          label="Bought Servers on this instance"
          rows={rows}
          columns={[...COLUMNS, powerColumn(setPowering)]}
          getRowId={(row) => row.id}
          rowName={(row) => row.name}
          selectable
          onSelectionChange={setChosen}
          key={shown}
          empty={
            <EmptyState icon="server" title={emptyTitle(shown)}>
              {shown === "below-floor"
                ? `Every Bought Server keeps at least the ${list.data.marginFloorPercent}% floor.`
                : "Every Bought Server on this instance is listed here from the moment it is bought."}
            </EmptyState>
          }
        />
      </Card.Body>
      <PowerModal powering={powering} onClose={() => setPowering(null)} />
      {repricing === null ? null : (
        <RepriceModal
          key={repricing}
          ids={chosen}
          open
          onOpenChange={(open) => {
            if (!open) setRepricing(null);
          }}
        />
      )}
    </Card>
  );
}

function emptyTitle(shown: Shown): string {
  return shown === "below-floor"
    ? "None below the margin floor"
    : "No Bought Servers yet";
}

/** The one rate every margin uses, or why there are no margins. */
export function rateSentence(view: OperatorBoughtServers): string {
  if (!view.exchangeRate) {
    return "The day's exchange rate cannot be read right now, so no margin is shown.";
  }
  const rate = `Margins at ${view.exchangeRate.usdPerEur} USD per EUR, the ECB reference rate of ${formatDay(view.exchangeRate.on)}. Flagged under ${view.marginFloorPercent}%.`;
  return view.costsRead
    ? rate
    : `${rate} The provider's EUR prices cannot be read right now, so no margin is shown.`;
}

const usd = (cents: number) => formatMoney(cents, "usd");

/** "$5.29 · 21.2%", with the flag under the floor; a dash while unknown. */
function marginCell(row: OperatorBoughtServer): React.ReactNode {
  if (!row.margin) return "—";
  return (
    <span className="inline-flex items-center gap-1.5">
      {`${usd(row.margin.marginCents)} · ${row.margin.marginPercent}%`}
      {row.belowFloor ? <Chip variant="warn">Below floor</Chip> : null}
    </span>
  );
}

const COLUMNS: Column<OperatorBoughtServer>[] = [
  {
    id: "name",
    head: "Server",
    tone: "key",
    cell: (row) => row.name,
    compare: (a, b) => a.name.localeCompare(b.name),
  },
  {
    id: "organization",
    head: "Organization",
    truncate: true,
    cell: (row) => (
      <span title={row.organization.name}>{row.organization.name}</span>
    ),
    compare: (a, b) => a.organization.name.localeCompare(b.organization.name),
  },
  {
    id: "size",
    head: "Size",
    cell: (row) => <Chip variant="mono">{row.serverType}</Chip>,
  },
  {
    id: "location",
    head: "Location",
    cell: (row) => <Chip variant="mono">{row.location}</Chip>,
  },
  {
    id: "stage",
    head: "Stage",
    cell: (row) => STAGE_LABELS[row.stage],
  },
  {
    id: "price",
    head: "Monthly price",
    tone: "num",
    cell: (row) => usd(row.monthlyCents),
    compare: (a, b) => a.monthlyCents - b.monthlyCents,
  },
  {
    id: "provider-id",
    head: "Provider id",
    cell: (row) => row.providerServerId ?? "—",
  },
  {
    id: "margin",
    head: "Margin",
    cell: marginCell,
    compare: (a, b) =>
      (a.margin?.marginPercent ?? 1e9) - (b.margin?.marginPercent ?? 1e9),
  },
  {
    id: "bought",
    head: "Bought",
    cell: (row) => <RowTime iso={row.createdAt} />,
    compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
  },
];
