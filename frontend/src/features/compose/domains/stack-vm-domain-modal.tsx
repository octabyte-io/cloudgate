import { Controller, FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { example } from "@/components/console/form-spec";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CLOUD_NAMES } from "@/lib/api/endpoints/cloud-accounts";
import type {
  CreateDomainInput,
  Domain,
  UpdateDomainInput,
} from "@/lib/api/endpoints/domains";

/** The port a Domain takes when none is given, as the API stores it. */
const DEFAULT_PORT = 3000;

/** What the dialog sends: the four things a Stack VM's Domain is. */
type StackVmDomainInput = Pick<
  CreateDomainInput,
  "host" | "path" | "serviceName" | "port"
>;

const PORT_RANGE = "Enter the port the service listens on, 1 to 65535.";

const stackVmDomainSchema = z.object({
  host: z.string().trim().min(1, "Enter the host to serve this stack on."),
  path: z
    .string()
    .trim()
    .transform((path) => path || "/"),
  serviceName: z
    .string()
    .trim()
    .min(1, "Choose the service this host reaches."),
  port: z.coerce
    .number(PORT_RANGE)
    .int(PORT_RANGE)
    .min(1, PORT_RANGE)
    .max(65535, PORT_RANGE),
});

type StackVmDomainValues = z.infer<typeof stackVmDomainSchema>;

/**
 * Add or edit a Domain of a Compose stack on its **Stack VM** (#1371): a host
 * of your own, a path, the compose service it reaches and that service's
 * port. Nothing else: the Domain is a rule on the Environment network's load
 * balancer with the cloud's own certificate, always HTTPS, so nothing
 * only Traefik honours is offered (the API refuses it anyway, naming the
 * field), and there is no generate button: a generated sslip.io host carries
 * a Server's public address, and a Stack VM has none.
 *
 * The port is the container's, as on a Server; the deploy publishes it on
 * the Stack VM at the same number, where the load balancer reaches it.
 */
export function StackVmDomainFormModal({
  domain,
  google,
  services,
  open,
  onOpenChange,
  create,
  update,
}: {
  /** `null` to add one. */
  domain: Domain | null;
  /** The stack is in a Google Cloud Environment: its host takes an A record. */
  google: boolean;
  /** The compose file's services; `names` is `undefined` when it could not be read. */
  services: { names: string[] | undefined; pending: boolean };
  open: boolean;
  onOpenChange: (open: boolean) => void;
  create: (input: StackVmDomainInput) => Promise<Domain>;
  update: (domainId: string, input: UpdateDomainInput) => Promise<Domain>;
}) {
  const form = useApiForm<StackVmDomainValues>({
    schema: stackVmDomainSchema,
    defaultValues: {
      host: domain?.host ?? "",
      path: domain?.path ?? "/",
      serviceName:
        domain?.serviceName ??
        (services.names?.length === 1 ? services.names[0] : ""),
      port: domain?.port ?? DEFAULT_PORT,
    },
    onSubmit: async (input) => {
      if (domain) await update(domain.domainId, input);
      else await create(input);
      toast.done(
        domain
          ? `${input.host} is changing on the load balancer.`
          : `${input.host} is being added; its DNS records appear in a moment.`,
      );
      onOpenChange(false);
    },
  });

  const names = services.names;
  const host = form.watch("host") ?? "";
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={domain ? `Edit ${domain.host}` : "Add a domain"}
        description={`Served over HTTPS by the Environment network's ${CLOUD_NAMES[google ? "gcp" : "aws"]} load balancer, with its own ${google ? "Google-managed" : "ACM"} certificate, to a service on this stack's Stack VM. A Stack VM has no generated host: type a host of your own. Cloudgate never writes DNS: you add the DNS records it shows at your DNS provider.`}
      />
      <FormProvider {...form}>
        <form method="post" noValidate onSubmit={form.submit}>
          <Modal.Body>
            <div className="flex flex-col gap-4">
              <Field
                name="host"
                label="Host"
                hint={
                  google
                    ? "An A record to the network's fixed IP, a bare name too."
                    : "A subdomain gets a CNAME; a bare name an ALIAS, ANAME or flattened CNAME — never an A record."
                }
              >
                <Input placeholder="shop.example.com" autoComplete="off" />
              </Field>
              <Field name="path" label="Path" optional>
                <Input placeholder="/" autoComplete="off" />
              </Field>
              <Field
                name="serviceName"
                label="Service"
                hint={
                  names
                    ? "Which service in the compose file this host reaches."
                    : "Typed, because the file could not be read — it is cloned by a Deployment, and this stack may not have had one yet."
                }
                manual={names !== undefined}
              >
                {names ? (
                  <Controller
                    name="serviceName"
                    control={form.control}
                    render={({ field }) => (
                      <Picker
                        mono
                        options={names.map((name) => ({
                          value: name,
                          label: name,
                        }))}
                        value={field.value}
                        onValueChange={field.onChange}
                        pending={services.pending}
                        placeholder={
                          names.length === 0
                            ? "This file declares no services"
                            : "Choose a service"
                        }
                      />
                    )}
                  />
                ) : (
                  <Input
                    placeholder={example("web")}
                    autoComplete="off"
                    spellCheck={false}
                    className="font-mono"
                  />
                )}
              </Field>
              <Field
                name="port"
                label="Port"
                hint="The port the service listens on in its container. Cloudgate publishes it on the Stack VM at the same number, open to the load balancer alone; two services cannot share one."
              >
                <Input
                  inputMode="numeric"
                  autoComplete="off"
                  className="font-mono"
                />
              </Field>
              {domain && host.trim() !== domain.host ? (
                <p className="text-meta text-tx-2">
                  A new host needs a new certificate and new DNS records.
                </p>
              ) : null}
            </div>
            <FormError message={form.rootError} />
          </Modal.Body>
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <SubmitButton pending={form.formState.isSubmitting}>
              {domain ? "Save changes" : "Add domain"}
            </SubmitButton>
          </Modal.Footer>
        </form>
      </FormProvider>
    </Modal>
  );
}
