import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { formatDay } from "@/lib/api/endpoints/billing";
import type { OperatorOrganization } from "@/lib/api/endpoints/operator";

import { useSetEnterprise } from "./use-operator";

type ModalProps = {
  organization: OperatorOrganization;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const COUNT_ERROR = "A whole number, 0 or more";
const WHOLE = /^\d+$/;

/** The counts are asked for only while Enterprise is on. */
const schema = z
  .object({
    enterprise: z.boolean(),
    servers: z.string(),
    cloudEnvironments: z.string(),
  })
  .superRefine((values, issues) => {
    if (!values.enterprise) return;
    for (const name of ["servers", "cloudEnvironments"] as const) {
      if (!WHOLE.test(values[name].trim())) {
        issues.addIssue({ code: "custom", path: [name], message: COUNT_ERROR });
      }
    }
  });
type Values = z.infer<typeof schema>;

const LABELS: Record<string, string> = {
  servers: "Servers",
  cloudEnvironments: "Cloud Environments",
};

/**
 * Switch an Organization's Enterprise marker and set its counts (ADR-0048,
 * ADR-0050). On, its allowance is the Servers and Cloud Environments
 * typed here, whatever its plan; switching it off ends the agreement, which
 * is a lapse (ADR-0052): frozen, owners and admins emailed, deleted in
 * 30 days unless it pays for a plan, and the switch says so first. The
 * backend refuses switching it on while a Stripe subscription is live — a
 * free trial included, which the switch names before it is saved —
 * and that refusal is shown here. Counts below what it uses refuse only its next
 * addition — nothing it has stops. On a Paying Organization (ADR-0059) the
 * counts and its use are the whole pool's, and switching off names every
 * Attached Organization that freezes with it.
 *
 * `useApiForm` + `Field` (§3.6): a 400 naming a count lands under its box,
 * anything else — the Stripe refusal — in the root error.
 */
export function EnterpriseModal({
  organization,
  open,
  onOpenChange,
}: ModalProps) {
  const save = useSetEnterprise();
  const form = useApiForm<Values>({
    schema,
    // An Enterprise Organization starts from its agreement's counts; another
    // from what it already uses, which is the least that refuses nothing new.
    defaultValues: {
      enterprise: organization.enterprise,
      servers: String(
        organization.enterprise
          ? organization.servers.allowed
          : organization.servers.used,
      ),
      cloudEnvironments: String(
        organization.enterprise
          ? organization.cloudEnvironments.allowed
          : organization.cloudEnvironments.used,
      ),
    },
    labelOf: (name) => LABELS[name],
    onSubmit: async (values) => {
      await save.mutateAsync({
        organizationId: organization.id,
        change: values.enterprise
          ? {
              enterprise: true,
              servers: Number(values.servers.trim()),
              cloudEnvironments: Number(values.cloudEnvironments.trim()),
            }
          : { enterprise: false },
      });
      toast.done(
        values.enterprise
          ? `${organization.name} is Enterprise.`
          : `${organization.name} is no longer Enterprise.`,
      );
      onOpenChange(false);
    },
  });
  const enterprise = form.watch("enterprise");
  const switchId = `enterprise-${organization.id}`;

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={`Enterprise for ${organization.name}`}
        description="An Enterprise Organization is billed by agreement: it gets SSO, SCIM, custom roles and forward auth, and the counts set here instead of the Hosted plan's."
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <div className="flex items-start gap-3 rounded-lg bg-panel-2 px-3.5 py-3">
              <Switch
                id={switchId}
                checked={enterprise}
                className="mt-0.5"
                onCheckedChange={(next) =>
                  form.setValue("enterprise", next, { shouldDirty: true })
                }
              />
              <label htmlFor={switchId} className="min-w-0 text-body text-tx">
                Enterprise
                <span className="mt-0.5 block text-meta text-tx-2">
                  {enterprise
                    ? onHint(organization)
                    : organization.enterprise
                      ? offHint(organization)
                      : "Off, it needs a plan to add a Server or Cloud Environment."}
                </span>
              </label>
            </div>
            {enterprise ? (
              <>
                <Field
                  name="servers"
                  label="Servers"
                  hint={countHint(organization, organization.servers.used)}
                >
                  <Input type="number" min={0} step={1} />
                </Field>
                <Field
                  name="cloudEnvironments"
                  label="Cloud Environments"
                  hint={countHint(
                    organization,
                    organization.cloudEnvironments.used,
                  )}
                >
                  <Input type="number" min={0} step={1} />
                </Field>
              </>
            ) : null}
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              Save
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}

/**
 * What switching off says before it is saved. On a Paying Organization it
 * names every Attached Organization, since its lapse freezes them all
 * (ADR-0059) — with the same Save button and nothing more to type.
 */
function offHint(organization: OperatorOrganization): string {
  const ends =
    "Switching it off ends the agreement: the Organization is frozen, its owners and admins are emailed, and it is deleted in 30 days unless it pays for a plan.";
  if (organization.attached.length === 0) return ends;
  const names = new Intl.ListFormat("en", { type: "conjunction" }).format(
    organization.attached.map((attached) => attached.name),
  );
  return `${ends} Its Attached Organizations freeze with it: ${names}.`;
}

/**
 * What a count is measured against: what it uses, or on a Paying
 * Organization what its whole pool uses (ADR-0059), since the counts are the
 * pool's.
 */
function countHint(organization: OperatorOrganization, used: number): string {
  const paysFor = organization.attached.length;
  if (paysFor === 0) {
    return `It has ${used}. Fewer refuses only its next one; nothing stops.`;
  }
  const them =
    paysFor === 1 ? "the 1 Organization" : `the ${paysFor} Organizations`;
  return `It and ${them} it pays for have ${used} together. Fewer refuses only the next one in any of them; nothing stops.`;
}

/**
 * What switching on says before it is saved: a free trial is named, with the
 * day it charges, since it can bill as surely as a paid plan.
 */
function onHint(organization: OperatorOrganization): string {
  if (!organization.enterprise && organization.state.kind === "trial") {
    return `Refused while it is on a free trial: the trial charges its card on ${formatDay(organization.state.endsAt)}, so it must end first, or the Organization would be billed twice.`;
  }
  return "Refused while it has an active Stripe subscription, so it is never billed twice.";
}
