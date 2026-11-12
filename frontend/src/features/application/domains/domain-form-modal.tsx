import { Controller, FormProvider } from "react-hook-form";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { Domain } from "@/lib/api/endpoints/domains";

import { DomainHostField } from "./domain-host-field";
import {
  schemaFor,
  type DomainBody,
  type DomainValues,
  type ServiceChoice,
} from "./domain-schema";
import { DomainServiceField } from "./domain-service-field";
import { DomainTlsFields } from "./domain-tls-fields";

/**
 * Add a domain, or edit one.
 *
 * One dialog for both: `POST /domains` and `PATCH /domains/:id` take the same
 * fields, and the only difference is that create carries the parent id — which
 * this screen already knows and the person filling it in does not need to see.
 *
 * The two field groups with reasoning of their own are their own files: the host
 * makes two network calls from inside the form (`domain-host-field.tsx`), and the
 * three TLS controls are one decision with one piece of state
 * (`domain-tls-fields.tsx`). What stays here is routing — a port and a path.
 */
export function DomainFormModal({
  appName,
  serverIp,
  serverId,
  domain,
  open,
  onOpenChange,
  create,
  update,
  service,
  noun = "Application",
  fixedPort,
  running,
}: {
  /** Seeds the generated host — the backend truncates it to 40 characters. */
  appName: string;
  /** Where a record should point, for the DNS helper. */
  serverIp: string | null;
  serverId: string | null;
  /** The domain being edited, or `null` to add one. */
  domain: Domain | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * The two writes, handed in rather than reached for.
   *
   * **This is what lets one dialog serve an Application and a Compose stack**
   * (F12): the routes are the same and only the parent id differs, so the parent
   * is the caller's — which keeps this file from knowing about either feature's
   * hooks and keeps the two from drifting into two dialogs.
   */
  create: (input: DomainBody) => Promise<unknown>;
  update: (domainId: string, input: DomainBody) => Promise<unknown>;
  /** Present for a Compose stack, where a host has to say which service it reaches. */
  service?: ServiceChoice;
  /** What owns this domain, for the two sentences that name it. */
  noun?: string;
  /**
   * A bucket's Domain: its whole host routes to this port, Garage's
   * S3 API, so the port, path and strip fields are not offered — a path
   * would break every signed request.
   */
  fixedPort?: number;
  /**
   * Whether the parent is running now, for the toast after an add:
   * only a running one answers on a new host at once. Left out where the
   * parent has no such status (a bucket), and the toast then claims neither.
   */
  running?: boolean;
}) {
  const wholeHost = fixedPort !== undefined;
  const editing = domain !== null;
  const withService = service !== undefined;

  /**
   * When the change reaches Traefik, which is **not** the same answer for both
   * parents.
   *
   * `DomainsService.create` awaits `regenerateTraefikConfig` inside the request
   * and Traefik's file provider reloads the rewritten file in under a second —
   * but `regenerateTraefikConfig` returns early for a Compose stack, whose
   * routers travel as labels injected at deploy time. So an Application's host
   * is live before this dialog closes and a stack's waits for a deploy, and
   * saying "the next Deployment" to both told every Application owner to
   * redeploy a working service for nothing.
   *
   * `withService` is the discriminator because it already is one: the service
   * field exists only for a stack, and it is what picks the schema two lines
   * down. `noun` is a display string and is nobody's flag.
   */
  const servedAfterDeploy = withService;
  // A row saved with HTTPS off and a certificate by an older version opens as what
  // Traefik does with it: no certificate.
  const storedCertificate = domain?.https ? domain.certificateType : "none";

  const form = useApiForm<DomainValues>({
    schema: schemaFor(withService),
    defaultValues: {
      serviceName: domain?.serviceName ?? "",
      host: domain?.host ?? "",
      port: fixedPort ?? domain?.port ?? 3000,
      path: domain?.path ?? "/",
      stripPath: domain?.stripPath ?? false,
      https: domain?.https ?? false,
      certificateType: storedCertificate,
      customCertResolver: domain?.customCertResolver ?? "",
    },
    onSubmit: async (values) => {
      const body: DomainBody = {
        host: values.host,
        port: values.port,
        path: values.path,
        stripPath: values.stripPath,
        https: values.https,
        // HTTPS off is certificate None.
        certificateType: values.https ? values.certificateType : "none",
        customCertResolver:
          values.https && values.certificateType === "custom"
            ? values.customCertResolver
            : null,
        ...(withService ? { serviceName: values.serviceName } : {}),
      };
      if (editing) {
        await update(domain.domainId, body);
        toast.done("Domain saved.", {
          description: `${values.host} routes to port ${values.port}.`,
        });
      } else {
        await create(body);
        toast.done(`${values.host} added.`, {
          description: addedDescription(noun, servedAfterDeploy, running),
        });
      }
      onOpenChange(false);
    },
    onError: (error) => toast.error(error),
  });

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={editing ? `Edit ${domain.host}` : "Add a domain"}
        description={
          editing
            ? servedAfterDeploy
              ? `Changes reach Traefik on this ${noun}'s next Deployment.`
              : "Changes reach Traefik as soon as they are saved."
            : `The host this ${noun} answers on, and the container port it routes to.`
        }
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            {service ? <DomainServiceField service={service} /> : null}

            <DomainHostField
              appName={appName}
              serverIp={serverIp}
              serverId={serverId}
              noun={noun}
            />

            {wholeHost ? (
              <p className="text-meta text-tx-2">
                Routes the whole host to port {fixedPort}, where the {noun}{" "}
                answers S3 requests.
              </p>
            ) : (
              <>
                <Field
                  name="port"
                  label="Container port"
                  hint={`The port the ${noun} listens on inside its container.`}
                >
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={65535}
                    autoComplete="off"
                  />
                </Field>

                <Field
                  name="path"
                  label="Path"
                  hint="Route this path and everything under it: /api takes /api and /api/…, not /apix. Ending it in / takes only what is under it: /v2/ takes /v2/… but not /v2. Leave it at / for the whole host."
                >
                  <Input
                    placeholder="/"
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono text-meta md:text-meta"
                  />
                </Field>

                <Field
                  name="stripPath"
                  label="Strip the path before proxying"
                  hint={`The ${noun} receives / instead of the path above. Needs a path other than /.`}
                  orientation="horizontal"
                  manual
                >
                  <Controller
                    name="stripPath"
                    control={form.control}
                    render={({ field }) => (
                      <Switch
                        checked={field.value}
                        onCheckedChange={(next) => field.onChange(next)}
                      />
                    )}
                  />
                </Field>
              </>
            )}

            <DomainTlsFields certificateType={storedCertificate} />

            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {editing ? "Save changes" : "Add domain"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}

/**
 * What the toast after an add says about when the host is answered.
 * It said "answering on it now" to an Application that had never run, under
 * a panel saying Cloudgate could not ask Traefik. Traefik logs nothing for a
 * router it accepts (`traefik-status/config-status-notice.tsx`), so what can
 * be said is that the route is written, and whether the parent is running to
 * answer on it.
 */
export function addedDescription(
  noun: string,
  servedAfterDeploy: boolean,
  running: boolean | undefined,
): string {
  if (servedAfterDeploy) {
    return `Its router travels as a label, so Traefik picks it up on the next Deployment of this ${noun}.`;
  }
  if (running === true) {
    return `Its route is written to Traefik, and this ${noun} is running, so it answers on it with no Deployment.`;
  }
  if (running === false) {
    return `Its route is written to Traefik. This ${noun} is not running, so it answers on it once it is: after its next Deployment or Start.`;
  }
  return `Its route is written to Traefik, so this ${noun} answers on it whenever it is running, with no Deployment.`;
}
