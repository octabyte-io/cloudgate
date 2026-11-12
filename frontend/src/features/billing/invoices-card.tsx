import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { DataTable } from "@/components/console/data-table";
import { Dash } from "@/components/console/dash";
import { EmptyState } from "@/components/console/empty-state";
import { QAList, QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import { formatMoney, type BillingState, type Invoice } from "@/lib/api/endpoints/billing";
import { useInvoices, useSetInvoiceNotifications } from "@/lib/api/use-billing";
import { Icon } from "@/lib/design/icons";
import { timeExact } from "@/lib/format/time";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../settings/section-states";

/**
 * What has been billed, and whether Cloudgate emails about it.
 *
 * ## Two units in one API, and this card holds both sides of it
 *
 * `amountDue` and `amountPaid` are Stripe's **minor units** (cents) and
 * `created`/`dueDate` are **Unix seconds**, while the plan card's
 * `currentPriceAmount` has already been divided by 100. `formatMoney` takes the
 * unit explicitly rather than inferring it from the size of the number, which is
 * how a $9 plan becomes $900 the first time somebody guesses.
 *
 * ## An empty list is genuinely empty here, unlike the catalogue next door
 *
 * `getInvoices` returns `[]` **without touching Stripe** when the Organization
 * has no `stripeCustomerId`, so "no invoices" is a real answer and not a
 * disguised failure. It does also swallow a Stripe error into `[]` — a bare
 * `catch { return [] }` — which is why the empty state says what it is
 * reading from rather than asserting nothing has ever been billed.
 *
 * ## Only on the Hosted instance
 *
 * `PATCH /billing/invoice-notifications` calls `assertCloud()` and answers a
 * 400 when self-hosted. The switch used to be offered there anyway and its only
 * answer was that refusal, in a toast over the switch. `BillingSection` now
 * renders this card only when `GET /settings/about` says `hosted`.
 */
export function InvoicesCard({
  subscription,
}: {
  subscription: BillingState;
}) {
  const invoices = useInvoices();
  const arrival = useArrival(invoices.isPending);
  const setNotifications = useSetInvoiceNotifications();

  return (
    <>
      <Card>
        <Card.Header
          title="Invoice emails"
          sub="Cloudgate can email the Organization's owner when an invoice is issued."
          headingLevel={2}
        />
        <Card.Body>
          <QAList>
            <QARow
              title="Email me about invoices"
              description="Sent to the Organization owner's address — the one Stripe bills — not to whoever changes this."
              action={
                <Switch
                  checked={subscription.sendInvoiceNotifications}
                  disabled={setNotifications.isPending}
                  aria-label="Email the Organization owner about invoices"
                  onCheckedChange={async (next) => {
                    try {
                      await setNotifications.mutateAsync(next);
                      toast.done(
                        next
                          ? "Invoice emails are on."
                          : "Invoice emails are off.",
                      );
                    } catch (error) {
                      toast.error(error);
                    }
                  }}
                />
              }
            />
          </QAList>
        </Card.Body>
      </Card>

      {invoices.isPending ? (
        <SectionPending title="Invoices" rows={3} />
      ) : invoices.error ? (
        <SectionFailed title="Invoices" error={invoices.error}>
          Reading invoices needs an owner or admin role in this Organization.
        </SectionFailed>
      ) : (
        <Card className={arrival}>
          <Card.Header
            title="Invoices"
            sub="From Stripe, newest first."
            headingLevel={2}
          />
          <Card.Body flush>
            <DataTable<Invoice>
              label="Invoices for this Organization"
              rows={invoices.data ?? []}
              /* Stripe types `invoice.id` optional and the projection keeps
                 that, so the fallback is the invoice number and then the
                 timestamp — a row still needs a stable key to sort under. */
              getRowId={(row) =>
                row.id ?? row.number ?? `invoice-${row.created}`
              }
              empty={
                <EmptyState icon="cash" title="No invoices">
                  Nothing has been billed to this Organization yet.
                </EmptyState>
              }
              columns={[
                {
                  id: "number",
                  head: "Invoice",
                  tone: "key",
                  cell: (row) =>
                    row.number ?? <Dash word="Not numbered" />,
                },
                {
                  id: "issued",
                  head: "Issued",
                  cell: (row) => (
                    <time dateTime={new Date(row.created * 1000).toISOString()}>
                      {timeExact(new Date(row.created * 1000).toISOString())}
                    </time>
                  ),
                  compare: (a, b) => a.created - b.created,
                },
                {
                  id: "amount",
                  head: "Amount",
                  tone: "num",
                  cell: (row) => formatMoney(row.amountDue, row.currency),
                  compare: (a, b) => a.amountDue - b.amountDue,
                },
                {
                  id: "status",
                  head: "Status",
                  cell: (row) =>
                    // Stripe's word, unmapped. `paid`, `open`, `void`,
                    // `uncollectible` — translating them would mean deciding
                    // what an unfamiliar one means.
                    row.status ? <Chip>{row.status}</Chip> : <Dash word="Unknown" />,
                },
                {
                  id: "links",
                  head: <span className="sr-only">Open</span>,
                  tone: "num",
                  cell: (row) => (
                    <span className="inline-flex gap-2.5">
                      {row.hostedInvoiceUrl ? (
                        <InvoiceLink href={row.hostedInvoiceUrl}>
                          View
                        </InvoiceLink>
                      ) : null}
                      {row.invoicePdf ? (
                        <InvoiceLink href={row.invoicePdf}>PDF</InvoiceLink>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          </Card.Body>
        </Card>
      )}
    </>
  );
}

/**
 * A link to Stripe's own copy of the invoice.
 *
 * A real link, not a button: F07's rule — a control that goes somewhere has to
 * be openable in a new tab, and an invoice is exactly the thing somebody opens
 * beside what they are reading. `noreferrer noopener` because it leaves the app.
 */
function InvoiceLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.25 text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
    >
      {children}
      <Icon name="ext" size={12} className="flex-none opacity-70" />
    </a>
  );
}
