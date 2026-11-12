import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CopyButton } from "@/components/console/copy-button";
import { EmptyState } from "@/components/console/empty-state";
import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { ProvenDomain } from "@/lib/api/endpoints/sso";
import { Icon } from "@/lib/design/icons";
import { useArrival } from "@/components/console/use-arrival";

import type { Stopped } from "../business-plan";
import { SectionFailed, SectionPending } from "../../settings/section-states";
import {
  useAddProvenDomain,
  useCheckProvenDomain,
  useProvenDomains,
  useRemoveProvenDomain,
} from "./use-sso";

/**
 * The email domains this Organization has shown it owns, on the Hosted instance
 * (ADR-0051).
 *
 * A provider's domain list says which addresses it is *for*; this card is what
 * lets it act on them. Each domain carries a TXT challenge to publish at the
 * domain's DNS provider, and **Check now** asks the backend to look it up there
 * and then — nothing polls, so a person who has just published the record
 * finds out at once. Until a domain is proven, no provider of this
 * Organization routes or accepts a sign-in for an address in it, which is what
 * keeps a domain listed by someone who does not own it from signing anybody in.
 *
 * Rendered by `SsoContent` only when the instance is Hosted: a Self-hosted
 * backend has no such routes.
 */
export function ProvenDomainsCard({
  stopped = null,
}: {
  stopped?: Stopped | null;
}) {
  const domains = useProvenDomains({ enabled: true });

  const arrival = useArrival(domains.isPending);
  if (domains.isPending) {
    return <SectionPending title="Proven domains" rows={2} />;
  }
  if (domains.error) {
    return (
      <SectionFailed title="Proven domains" error={domains.error}>
        Proving a domain needs an owner or admin role in this Organization.
      </SectionFailed>
    );
  }

  const rows = domains.data ?? [];

  return (
    <Card className={arrival}>
      <Card.Header
        title="Proven domains"
        sub="Email domains this Organization has shown it owns. A provider signs in only addresses in a proven domain."
        headingLevel={2}
      />
      <Card.Body className="grid gap-3.5">
        {rows.length === 0 ? (
          <EmptyState icon="globe" title="No proven domains yet">
            Add the domain your people&rsquo;s addresses end in, then publish the TXT
            record it gives you. Providers sign nobody in until a domain they list
            is proven.
          </EmptyState>
        ) : (
          <ul className="grid gap-2">
            {rows.map((row) => (
              <ProvenDomainRow
                key={row.domain}
                row={row}
                stoppedReason={stopped?.reason ?? null}
              />
            ))}
          </ul>
        )}

        <AddProvenDomainForm stoppedReason={stopped?.reason ?? null} />
      </Card.Body>
    </Card>
  );
}

const addSchema = z.object({
  domain: z.string().trim().min(1, "Type the domain, e.g. acme.com"),
});
type AddValues = z.infer<typeof addSchema>;

/**
 * Add a domain to receive its challenge (§3.6): a 400 naming `domain` lands
 * under the box, anything else in the root error.
 */
function AddProvenDomainForm({
  stoppedReason,
}: {
  /** Kept but stopped: adding is off, with why. */
  stoppedReason: string | null;
}) {
  const add = useAddProvenDomain();
  const form = useApiForm<AddValues>({
    schema: addSchema,
    defaultValues: { domain: "" },
    labelOf: (name) => (name === "domain" ? "Domain" : undefined),
    onSubmit: async ({ domain }) => {
      const added = await add.mutateAsync(domain.trim());
      toast.done(`Publish the TXT record for ${added.domain}, then check it.`);
      form.reset({ domain: "" });
    },
  });

  return (
    <FormProvider {...form}>
      <form
        method="post"
        noValidate
        onSubmit={form.submit}
        className="grid gap-2"
      >
        <div className="flex flex-wrap items-start gap-2">
          <Field
            name="domain"
            label="Add a domain"
            hint="The part of your people's addresses after the @, e.g. acme.com."
            className="min-w-56 flex-1"
          >
            <Input autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <FormError message={form.rootError} />
        <SubmitButton
          variant="gh"
          className="justify-self-start"
          pending={form.formState.isSubmitting}
          disabled={stoppedReason !== null}
          title={stoppedReason ?? undefined}
        >
          Add domain
        </SubmitButton>
      </form>
    </FormProvider>
  );
}

function ProvenDomainRow({
  row,
  stoppedReason,
}: {
  row: ProvenDomain;
  /** Kept but stopped: checking is off, removing stays on. */
  stoppedReason: string | null;
}) {
  const check = useCheckProvenDomain();
  const remove = useRemoveProvenDomain();

  async function checkNow() {
    try {
      const checked = await check.mutateAsync(row.domain);
      if (checked.proven) {
        toast.done(`${row.domain} is proven.`);
      } else {
        toast.info(`The TXT record for ${row.domain} is not there yet.`, {
          description:
            "DNS changes can take a while to show. Check again once your DNS provider has published it.",
        });
      }
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <li className="grid gap-2 rounded-lg border border-line bg-panel-2 p-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-ui text-tx">
          {row.domain}
        </span>
        <Chip variant={row.proven ? "brand" : "default"}>
          {row.proven ? "Proven" : "Waiting for the record"}
        </Chip>
        <Button
          type="button"
          size="icon-xs"
          variant="qt"
          aria-label={`Remove ${row.domain}`}
          disabled={remove.isPending}
          onClick={async () => {
            try {
              await remove.mutateAsync(row.domain);
              toast.done(`${row.domain} is no longer proven.`);
            } catch (error) {
              toast.error(error);
            }
          }}
        >
          <Icon name="x" size={14} />
        </Button>
      </div>

      {row.proven ? null : (
        <>
          <dl className="grid gap-1 text-meta text-tx-2">
            <RecordPart label="Type" value={row.record.type} />
            <RecordPart
              label="Name"
              value={row.record.name}
              copy="record name"
            />
            <RecordPart
              label="Value"
              value={row.record.value}
              copy="record value"
            />
          </dl>
          <Button
            type="button"
            variant="gh"
            className="justify-self-start"
            disabled={check.isPending || stoppedReason !== null}
            title={stoppedReason ?? undefined}
            aria-busy={check.isPending || undefined}
            onClick={checkNow}
          >
            Check now
          </Button>
        </>
      )}
    </li>
  );
}

function RecordPart({
  label,
  value,
  copy,
}: {
  label: string;
  value: string;
  copy?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <dt className="w-12 shrink-0">{label}</dt>
      <dd className="min-w-0 flex-1 font-mono wrap-anywhere text-tx">
        {value}
      </dd>
      {copy ? <CopyButton value={value} label={copy} size="icon-xs" /> : null}
    </div>
  );
}
