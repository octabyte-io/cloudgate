import { useRouter } from "next/navigation";
import { useState } from "react";
import { FormProvider } from "react-hook-form";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { ResourceField } from "@/components/console/resource-field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { TAKES_HF_TOKEN } from "@/lib/api/endpoints/applications";
import { useGpuCountsEach } from "@/lib/api/use-gpu";
import type { DeployTarget } from "@/lib/api/endpoints/environments";
import { useServers } from "@/lib/api/use-servers";
import { useCreateServerPicker } from "@/lib/forms/create-server-picker";

import { MODEL_NAMING, RUNTIME_OPTIONS } from "../model/inference-runtimes";

import {
  BLANK_AI_MODEL,
  createAiModelSchema,
  hostWithCards,
  toCreateAiModelInput,
  type CreateAiModelValues,
} from "./create-ai-model-values";
import { useCreateApplication } from "./use-create-application";
import { example } from "@/components/console/form-spec";

/** The Server picker's hint, wherever the host is or is not a choice. */
const HOST_HINT =
  "Which host it runs on, with its GPUs and how many are free right now.";

/**
 * Add an **AI model** to an Environment: an Application with the model
 * facet, created on `POST /applications` like any other, which then lands on
 * its own Model tab.
 *
 * **The Server picker reads each host's cards** — "gpu-1 · 2 GPUs, 1 free" —
 * from the counts-only read, because where an AI model runs is mostly
 * a question of where the GPUs are, and asking for more than a host has free
 * is refused by the save, not here. The read needs `service: ['create']`,
 * which the button that opens this already required.
 */
export function CreateAiModelModal({
  environmentId,
  environmentName,
  deployTarget,
  open,
  onOpenChange,
}: {
  environmentId: string;
  environmentName: string;
  deployTarget: DeployTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} wide>
      <Modal.Header
        title="Add an AI model"
        description={`A model served by an inference runtime, deployed into ${environmentName}.`}
      />
      {/* Mounted with the dialog and torn down with it, for the reason the
          Application dialog gives: `useApiForm` reads its defaults once. */}
      {open ? (
        <Details
          environmentId={environmentId}
          deployTarget={deployTarget}
          onDone={() => onOpenChange(false)}
        />
      ) : null}
    </Modal>
  );
}

function Details({
  environmentId,
  deployTarget,
  onDone,
}: {
  environmentId: string;
  deployTarget: DeployTarget;
  onDone: () => void;
}) {
  const router = useRouter();
  const create = useCreateApplication(environmentId);
  const servers = useServers();
  const picker = useCreateServerPicker(deployTarget);
  const [serverId, setServerId] = useState("");
  // The host's cards are read only where it is a choice: the Hosted
  // instance refuses that read with the host itself.
  const hosts = [
    ...(picker.platformHost ? [null] : []),
    ...(servers.data ?? []).map((each) => each.serverId),
  ];
  const cards = useGpuCountsEach(hosts, true);

  const form = useApiForm<CreateAiModelValues>({
    schema: createAiModelSchema,
    defaultValues: BLANK_AI_MODEL,
    onSubmit: async (values) => {
      const row = await create.mutateAsync(
        toCreateAiModelInput(
          values,
          environmentId,
          picker.serverIdOf(serverId),
        ),
      );
      toast.done(`${values.name.trim()} created.`, {
        description:
          "It is not deployed yet — deploy it to pull the model and serve it.",
      });
      onDone();
      router.push(`/applications/${row.applicationId}/model`);
    },
    onError: (error) => toast.error(error),
  });

  const values = form.watch();

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit}>
        <Modal.Body>
          <ResourceField
            spec={{
              kind: "text",
              name: "name",
              label: "Name",
              placeholder: example("Support assistant"),
              hint: "What this AI model is called in Cloudgate.",
            }}
            values={values}
          />

          <ResourceField
            spec={{
              kind: "text",
              name: "description",
              label: "Description",
              optional: true,
              placeholder: example("Answers support questions"),
              hint: "What it is for, for whoever finds it next.",
            }}
            values={values}
          />

          <Field
            name="serverId"
            label="Server"
            manual
            optional={picker.optional}
            hint={picker.hint(HOST_HINT, HOST_HINT)}
          >
            <Picker
              options={picker.options(servers.data, (name, id) =>
                hostWithCards(name, cards.get(id)),
              )}
              pending={servers.isPending}
              placeholder={picker.placeholder}
              value={serverId}
              onValueChange={setServerId}
            />
          </Field>

          <ResourceField
            spec={{
              kind: "select",
              name: "runtime",
              label: "Inference runtime",
              options: RUNTIME_OPTIONS,
              hint: "What serves the model. Fixed once the AI model is created.",
            }}
            values={values}
          />

          <ResourceField
            spec={{
              kind: "text",
              name: "model",
              label: "Model",
              mono: true,
              placeholder: MODEL_NAMING[values.runtime].placeholder,
              hint: `${MODEL_NAMING[values.runtime].naming} The first deploy ${MODEL_NAMING[values.runtime].deploy}`,
            }}
            values={values}
          />

          {TAKES_HF_TOKEN[values.runtime] ? (
            <ResourceField
              spec={{
                kind: "password",
                name: "hfToken",
                label: "Hugging Face token",
                optional: true,
                hint: "For gated weights. Given to the model as HF_TOKEN and never shown again, only whether one is set.",
              }}
              values={values}
            />
          ) : null}

          <ResourceField
            spec={{
              kind: "number",
              name: "gpus",
              label: "GPUs",
              min: 0,
              hint: "Whole cards per running copy. Zero runs it on the CPU.",
            }}
            values={values}
          />

          <FormError message={form.rootError} />
        </Modal.Body>

        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <SubmitButton pending={form.formState.isSubmitting}>
            Create AI model
          </SubmitButton>
        </Modal.Footer>
      </form>
    </FormProvider>
  );
}
