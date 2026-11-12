import { FormProvider } from "react-hook-form";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { ResourceField } from "@/components/console/resource-field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import type { MetricsConfigInput } from "@/lib/api/endpoints/monitoring";
import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import type { SamplingState } from "@/lib/format/sampling";

import {
  metricsFields,
  metricsFormSchema,
  toMetricsConfig,
  valuesFor,
  type MetricsFormValues,
} from "./metrics-config-spec";

/**
 * Which host this dialog is configuring.
 *
 * **The web server is a host with no row**, so the dialog cannot take a
 * `Server`: it takes the four things that actually differ between the two, and
 * the config it is editing. `save` is passed in rather than a mutation being
 * chosen here, because the two routes are two different hooks and the caller
 * already holds the right one.
 */
export interface SetupTarget {
  /** What the operator calls this host. Used in the title and the toast. */
  name: string;
  /**
   * Whether a history is being kept for it, was kept and stopped, or never was.
   * Decides the verbs: a stopped host is *resumed* with the settings it kept,
   * not set up from nothing.
   */
  state: SamplingState;
  /** The stored config: what the form prefills from, and carries through. */
  config: MetricsConfig;
  /** Completes "samples of this host, …" — `over SSH`, or the local shell. */
  reach: string;
  /** One sentence saying how Cloudgate reaches this host, for the dialog head. */
  description: string;
  /** Anything true of this host and no other. Sits above the fields. */
  caveat?: React.ReactNode;
  save: (input: MetricsConfigInput) => Promise<unknown>;
}

/**
 * How Cloudgate samples one host.
 *
 * The form the F13 brief pointed at rather than growing its own. One dialog for
 * both jobs — turning collection on, and changing it afterwards — because they
 * write the same route with the same body, and the only difference is which verb
 * belongs on the button.
 *
 * **And one dialog for both hosts**: a Server, and the
 * machine Cloudgate itself runs on. `POST /monitoring/servers/:id/setup` and
 * `POST /admin/setup-monitoring` validate identical bodies, so a second form would
 * have been the same eight fields with the same three warnings and its own drift.
 * What varies is a name, a reach, a caveat and a mutation — which is what
 * `SetupTarget` is.
 *
 * **What it does not ask for is in `metrics-config-spec.ts`**: the token, the
 * port and the callback URL, none of which change anything in this backend. The
 * footer says so out loud rather than leaving the operator to wonder why a
 * "monitoring token" was never mentioned.
 *
 * **The empty include list is called out while it is still empty**, not only in a
 * field hint. It is the one default that quietly means "never" — no container
 * metrics on this host, for ever, with no error anywhere to find out from — and a
 * hint under a field the operator has already skipped past is not where that
 * belongs.
 *
 * The dialog is **keyed by every opening** at the call site, F09's fix: a form
 * that stays mounted across a close keeps what was typed, and a half-edited
 * retention window reappearing next time somebody opens this is how a host ends
 * up with a setting nobody chose.
 */
export function MonitoringSetupModal({
  target,
  open,
  onOpenChange,
}: {
  target: SetupTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { state, config, name } = target;
  const collecting = state === "collecting";

  const form = useApiForm<MetricsFormValues>({
    schema: metricsFormSchema,
    defaultValues: valuesFor(config) as never,
    onSubmit: async (values) => {
      await target.save(toMetricsConfig(config, values));
      toast.done(
        collecting
          ? `Sampling changed for ${name}.`
          : state === "stopped"
            ? `Cloudgate is sampling ${name} again.`
            : `Cloudgate is now sampling ${name}.`,
      );
      onOpenChange(false);
    },
    onError: (error) => toast.error(error),
  });

  const values = form.watch();
  const collectsNoContainers =
    values.include === undefined || values.include.trim() === "";

  return (
    <Modal wide open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={
          collecting
            ? `Sampling of ${name}`
            : state === "stopped"
              ? `Resume sampling ${name}`
              : `Monitor ${name}`
        }
        description={
          collecting
            ? "Cloudgate is already sampling this host. Changing any of these re-registers the collection jobs immediately."
            : state === "stopped"
              ? "Sampling of this host was stopped, and these are the settings it kept. The samples stored before the stop are still there; saving starts adding to them again one interval from now."
              : target.description
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <div className="grid gap-3.5">
              {target.caveat ? (
                <p className="flex items-start gap-2 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx-2">
                  <Icon
                    name="alert"
                    size={14}
                    className="mt-0.5 flex-none text-warn"
                  />
                  <span>{target.caveat}</span>
                </p>
              ) : null}
              {metricsFields(target.reach).map((spec) => (
                <ResourceField key={spec.name} spec={spec} values={values} />
              ))}
              {collectsNoContainers ? (
                <p className="flex items-start gap-2 rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx-2">
                  <Icon
                    name="alert"
                    size={14}
                    className="mt-0.5 flex-none text-warn"
                  />
                  <span>
                    With nothing included above,{" "}
                    <strong className="font-medium text-tx">
                      no container metrics are collected on this host at all
                    </strong>{" "}
                    — not now and not later. The collector returns before it runs{" "}
                    <code className="font-mono">docker stats</code> when the list
                    is empty, and there is no value that means everything. Host
                    CPU, memory and disk are still collected.
                  </span>
                </p>
              ) : null}
              <FormError message={form.rootError} />
            </div>
            <p className="mt-4 border-t border-line pt-3.5 text-meta text-tx-2">
              This route also stores a token, a port and a callback URL.{" "}
              <strong className="font-medium text-tx">
                None of the three changes how Cloudgate collects
              </strong>{" "}
              — they describe where an external metrics agent would post its own
              samples, and Cloudgate deploys no agent. The port and the callback
              URL go back unchanged. The token is the switch, and saving never
              rotates one that is already set: whatever the host has stored is
              kept, either sent back unchanged or — where the console is not
              shown it — left out of the request entirely. A value is only ever
              written where there was none, which is what starting sampling
              does, and sending an empty one is what clears it. That is why
              turning collection off is a separate control rather than a field
              here.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {collecting
                ? "Save changes"
                : state === "stopped"
                  ? "Resume sampling"
                  : "Start sampling"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
