import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { KVList, KVRow } from "@/components/console/kv-list";
import { SettingsCard } from "@/components/console/settings-card";
import type {
  AiModel,
  ApplicationDetail,
} from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";

import { APPLICATION_SETTINGS_REFUSAL } from "../use-application";
import { MODEL_NAMING, RUNTIME_LABEL } from "./inference-runtimes";

/**
 * An AI model's settings: what it serves and on which image.
 *
 * **Only what the API lets an operator change is a field.** The runtime is
 * fixed at create, so it is a read-out; the image repository, command,
 * port and health check are the platform's and are not offered at all. What is
 * left is the model — read at deploy, so a change waits for the next one — and
 * the image tag, which runs the platform's tested **pin** unless another is
 * named. Naming another is allowed and said plainly: "Off the pin".
 *
 * GPUs are shown, not edited, here: they are the Resources card's field on the
 * Advanced tab, and two cards writing one column would each save the other's
 * stale value.
 */

const schema = z.object({
  model: z.string().trim().min(1, "An AI model needs a model to serve."),
  imageTag: z.string().trim(),
});

type Values = z.infer<typeof schema>;

/** What the form opens holding. On the pin is an empty tag, not the pin's. */
export function modelDefaults(facet: AiModel): Values {
  return { model: facet.model, imageTag: facet.offPin ? facet.imageTag : "" };
}

/**
 * The form's values as `PATCH /applications/:id` takes them. An empty tag is
 * `null` — back to the pin, and to whatever the pin becomes — rather than the
 * pin's tag written down, which would stay put when the platform moves on.
 */
export function toModelEdit(values: Values): {
  aiModel: { model: string; imageTag: string | null };
} {
  const imageTag = values.imageTag.trim();
  return {
    aiModel: {
      model: values.model.trim(),
      imageTag: imageTag === "" ? null : imageTag,
    },
  };
}

export function ModelSettingsCard({
  application,
  facet,
  save,
}: {
  application: ApplicationDetail;
  facet: AiModel;
  save: (input: Record<string, unknown>) => Promise<unknown>;
}) {
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const gpus = application.gpus;

  return (
    <SettingsCard
      title="Model"
      gate={{ allowed: canSave.allowed, refusal: APPLICATION_SETTINGS_REFUSAL }}
      lede="What this AI model serves, and the runtime image it serves it on."
      schema={schema}
      defaultValues={modelDefaults(facet)}
      fields={(values) => [
        {
          kind: "text",
          name: "model",
          label: "Model",
          mono: true,
          placeholder: MODEL_NAMING[facet.runtime].placeholder,
          hint: `${MODEL_NAMING[facet.runtime].naming} Takes effect on the next deploy, which ${MODEL_NAMING[facet.runtime].deploy}`,
        },
        {
          kind: "text",
          name: "imageTag",
          label: "Image tag",
          optional: true,
          mono: true,
          placeholder: facet.pin,
          hint: tagReading(values.imageTag, facet.pin),
        },
      ]}
      submit={(values) => save(toModelEdit(values))}
      savedMessage="Model settings saved."
      footer="Neither reaches the running AI model until the next Deployment."
    >
      <KVList>
        <KVRow label="Inference runtime" value={RUNTIME_LABEL[facet.runtime]} />
        <KVRow
          label="Image"
          mono
          value={
            <span className="inline-flex items-center gap-1.5">
              {facet.imageTag}
              {facet.offPin ? <Chip>Off the pin</Chip> : null}
            </span>
          }
        />
        <KVRow
          label="GPUs reserved"
          value={
            gpus === 0
              ? "None — set them on the Advanced tab"
              : `${gpus} per copy`
          }
        />
      </KVList>
    </SettingsCard>
  );
}

/** Where the tag being typed stands against the pin. */
function tagReading(typed: string, pin: string): React.ReactNode {
  const tag = typed.trim();
  if (tag === "" || tag === pin) {
    return (
      <>
        <strong className="font-medium text-tx-2">On the pin, {pin}</strong>
        {" · "}
        The tag the platform was tested with. Name another to run off it.
      </>
    );
  }
  return (
    <>
      <strong className="font-medium text-tx-2">Off the pin</strong>
      {" · "}
      The platform was tested with {pin}. Empty returns to it.
    </>
  );
}
