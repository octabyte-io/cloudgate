import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Picker } from "@/components/console/picker";
import { ResourceField } from "@/components/console/resource-field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import {
  STACK_VM_SIZE_WORDS,
  STACK_VM_STARTING_SIZE,
} from "@/lib/api/endpoints/compose";
import type { DeployTarget } from "@/lib/api/endpoints/environments";
import { useServers } from "@/lib/api/use-servers";
import { useCreateServerPicker } from "@/lib/forms/create-server-picker";
import { serviceNameField } from "@/lib/forms/service-name";

import { useCreateCompose } from "../use-compose";
import { example } from "@/components/console/form-spec";

/**
 * Add a Compose stack to an Environment.
 *
 * **F11 opened this door and left it open for F12.** F08 shipped the Environment's
 * Services tab with no "Add a service" button, because a control that adds a row to
 * a list which cannot show rows is a dead end. F11's answer was that `POST /compose`
 * returns the new row, so creating ends on the new stack's own screen and F07's rail
 * records it in Recents on the way — permanently reachable by clicking, without the
 * list ever existing.
 *
 * That list exists now,
 * which retires the objection rather than the design: ending on the thing you just
 * made is still where somebody who just made one wants to be, and the Services tab
 * now shows it afterwards too.
 *
 * **Where the file comes from is asked here, and it has to be.** The column
 * defaults to `github`, and the create is made before any file is written, so a
 * stack created without saying anything claims a GitHub source it has no
 * connection for. Choosing "a file written here" therefore sends
 * `sourceType: "raw"` in the create itself. It used to be a second call
 * (`PATCH { sourceType: "raw" }`) whose failure was swallowed, which left a
 * stack the deploy refused (#1338); the create takes `sourceType` now, so it is
 * one request. "From a repository" sends none: the row keeps the default with
 * no repository, which the stack's Source and Stack cards read as not set
 * rather than as GitHub, and which a deploy is refused on until one is chosen.
 *
 * **In a Cloud Environment there is no Server to ask for** (#1372, ADR-0070):
 * every new stack there runs on its own Stack VM, which the Environment's plan
 * makes once an operator applies it. So the Server picker and the Swarm choice
 * (a Stack VM runs docker-compose only) give way to the Stack VM's starting
 * size and a note on what it costs, and the create sends no `serverId`.
 */
const schema = z.object({
  name: serviceNameField("A stack needs a name."),
  description: z.string(),
});
type Values = z.infer<typeof schema>;

type Origin = "raw" | "git";

export function CreateComposeModal({
  environmentId,
  environmentName,
  deployTarget,
  open,
  onOpenChange,
}: {
  environmentId: string;
  environmentName: string;
  /** Where the Environment deploys: in a cloud one the stack gets a Stack VM. */
  deployTarget: DeployTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [origin, setOrigin] = useState<Origin>("raw");

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) setOrigin("raw");
        onOpenChange(next);
      }}
      wide
    >
      <Modal.Header
        title="Add a Compose stack"
        description={`Several containers deployed together from one file, in ${environmentName}.`}
      />
      <Details
        // A fresh form per origin is not needed — the fields do not change — but
        // the key keeps `useApiForm`'s one-time `defaultValues` read honest if
        // anything is added to it later.
        environmentId={environmentId}
        deployTarget={deployTarget}
        origin={origin}
        onOrigin={setOrigin}
        onDone={() => onOpenChange(false)}
      />
    </Modal>
  );
}

function Details({
  environmentId,
  deployTarget,
  origin,
  onOrigin,
  onDone,
}: {
  environmentId: string;
  deployTarget: DeployTarget;
  origin: Origin;
  onOrigin: (origin: Origin) => void;
  onDone: () => void;
}) {
  const router = useRouter();
  const create = useCreateCompose(environmentId);
  const servers = useServers();
  const picker = useCreateServerPicker(deployTarget);
  const [serverId, setServerId] = useState("");
  const [swarm, setSwarm] = useState(false);
  const chosen = picker.serverIdOf(serverId);
  const onStackVm = deployTarget.kind === "cloud";

  const form = useApiForm<Values>({
    schema,
    defaultValues: { name: "", description: "" },
    onSubmit: async (values) => {
      const row = await create.mutateAsync({
        name: values.name,
        ...(values.description.trim() === ""
          ? {}
          : { description: values.description.trim() }),
        environmentId,
        composeType: swarm && !onStackVm ? "stack" : "docker-compose",
        // `null` for this Cloudgate host. Never sent in a cloud Environment:
        // the stack runs on its own Stack VM there, and the API refuses a
        // Server named.
        ...(onStackVm || chosen === undefined ? {} : { serverId: chosen }),
        composeFile: "",
        // The file is empty, so the API would store its `github` default
        // without being told — see the note on the component.
        ...(origin === "raw" ? { sourceType: "raw" as const } : {}),
      });

      toast.done(`${values.name} created.`, {
        description: onStackVm
          ? "Its Stack VM is made when you apply this Environment's plan. Then write its compose file and deploy."
          : origin === "raw"
            ? "It is not deployed yet — write its compose file, then deploy."
            : "It is not deployed yet — point it at a repository, then deploy.",
      });
      onDone();
      router.push(`/compose/${row.composeId}`);
    },
    onError: (error) => toast.error(error),
  });

  const values = form.watch();

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit}>
        <Modal.Body>
          <PickGrid label="Where the compose file comes from">
            <PickCard
              icon="pencil"
              title="A file written here"
              description="Stored in Cloudgate and edited on the stack's own screen. Nothing is cloned."
              selected={origin === "raw"}
              onClick={() => onOrigin("raw")}
            />
            <PickCard
              icon="branch"
              title="From a repository"
              description="Cloned from a git provider on every Deployment. Set the connection next, on the stack's screen."
              selected={origin === "git"}
              onClick={() => onOrigin("git")}
            />
          </PickGrid>

          <ResourceField
            spec={{
              kind: "text",
              name: "name",
              label: "Name",
              placeholder: example("Storefront workers"),
              hint: "What this stack is called in Cloudgate. Its Docker stack name is generated and cannot be changed.",
            }}
            values={values}
          />

          <ResourceField
            spec={{
              kind: "text",
              name: "description",
              label: "Description",
              optional: true,
              placeholder: example(
                "Redis, MinIO and the worker that reads them",
              ),
              hint: "What this stack is for, for whoever finds it next.",
            }}
            values={values}
          />

          {onStackVm ? (
            <StackVmStart />
          ) : (
            <>
              <Field
                name="composeType"
                label="Applied as"
                manual
                hint="Docker Compose brings the file up on one host. A Swarm stack schedules it across the Swarm, and Cloudgate routes its Domains through a Traefik file on its Server. This can be changed later; the next deploy then removes the old kind first, keeping its volumes."
              >
                <Picker
                  options={[
                    { value: "docker-compose", label: "Docker Compose" },
                    { value: "stack", label: "Swarm stack" },
                  ]}
                  value={swarm ? "stack" : "docker-compose"}
                  onValueChange={(next) => setSwarm(next === "stack")}
                />
              </Field>

              <Field
                name="serverId"
                label="Server"
                manual
                optional={picker.optional}
                hint={picker.hint(
                  "Which host it runs on. Leave it on this Cloudgate host unless the Environment's other services are somewhere else.",
                  "Which of your Servers it runs on.",
                )}
              >
                <Picker
                  options={picker.options(servers.data)}
                  pending={servers.isPending}
                  placeholder={picker.placeholder}
                  value={serverId}
                  onValueChange={setServerId}
                />
              </Field>
            </>
          )}

          <FormError message={form.rootError} />
        </Modal.Body>

        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <SubmitButton pending={form.formState.isSubmitting}>
            Create stack
          </SubmitButton>
        </Modal.Footer>
      </form>
    </FormProvider>
  );
}

/**
 * What a new stack in a Cloud Environment runs on, in place of the Server
 * picker: its own Stack VM, the size it starts at, and what it costs.
 */
function StackVmStart() {
  return (
    <section
      aria-label="Stack VM"
      className="flex flex-col gap-1.5 rounded-xl border border-line bg-panel-2 px-4 py-3"
    >
      <p className="text-body font-semibold text-tx">
        Runs on its own Stack VM
      </p>
      <p className="text-body text-tx-2">
        This Environment deploys to a Cloud account, so the stack runs on a VM
        Cloudgate makes for it there, never on a Server. It starts at size{" "}
        {STACK_VM_STARTING_SIZE} ({STACK_VM_SIZE_WORDS[STACK_VM_STARTING_SIZE]})
        with a 20 GB data disk for its volumes; change either on the
        stack&rsquo;s page.
      </p>
      <p className="text-body text-tx-2">
        Cost: your cloud account bills the machine, its disk and daily
        snapshots. The Environment&rsquo;s plan shows the machine type and its
        monthly price, and nothing is made until you apply it.
      </p>
    </section>
  );
}
