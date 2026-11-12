import { useState } from "react";
import { z } from "zod";

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";

import { KVList, KVRow } from "@/components/console/kv-list";
import { SettingsCard } from "@/components/console/settings-card";
import type { AiModel } from "@/lib/api/endpoints/applications";
import { usePermission } from "@/lib/auth/use-permission";

import { APPLICATION_SETTINGS_REFUSAL } from "../use-application";
import { RUNTIME_LABEL } from "./inference-runtimes";

const schema = z.object({
  hfToken: z.string().trim().min(1, "Paste the token to set."),
});

type Values = z.infer<typeof schema>;

/** The token edit `PATCH /applications/:id` takes: `''` removes it (ADR-0019). */
export type HfTokenEdit = { aiModel: { hfToken: string } };

/** The form's value as `PATCH /applications/:id` takes it. */
export function toHfTokenEdit(values: Values): HfTokenEdit {
  return { aiModel: { hfToken: values.hfToken.trim() } };
}

/**
 * A vLLM or llama.cpp AI model's Hugging Face token, for gated
 * weights.
 *
 * **Write-only.** The API never returns it, only `hasHfToken`, so the card
 * reads "Set" or "Not set" and the field always opens empty: what is typed
 * replaces the stored token, and is never the stored one shown back.
 * **Remove token** sends `''`, which clears it.
 */
export function ModelHfTokenCard({
  facet,
  save,
}: {
  facet: AiModel;
  save: (input: HfTokenEdit) => Promise<unknown>;
}) {
  // `PATCH /applications/:id` runs `findOwnedForUpdate`: `service: ['update']`.
  const canSave = usePermission({ service: ["update"] });
  const [removing, setRemoving] = useState(false);

  async function remove() {
    setRemoving(true);
    try {
      await save({ aiModel: { hfToken: "" } });
      toast.done("Hugging Face token removed.");
    } catch (error) {
      toast.error(error);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <SettingsCard
      title="Hugging Face token"
      gate={{ allowed: canSave.allowed, refusal: APPLICATION_SETTINGS_REFUSAL }}
      lede={`Lets ${RUNTIME_LABEL[facet.runtime]} download gated weights. Given to the model as HF_TOKEN, and never shown again.`}
      schema={schema}
      defaultValues={{ hfToken: "" }}
      fields={[
        {
          kind: "password",
          name: "hfToken",
          label: facet.hasHfToken ? "Replace token" : "Token",
          hint: facet.hasHfToken
            ? "A new token replaces the one set."
            : "From your Hugging Face account's access tokens.",
        },
      ]}
      submit={(values) => save(toHfTokenEdit(values))}
      savedMessage="Hugging Face token saved."
      footer="The running AI model keeps the token it started with until the next Deployment."
    >
      <KVList>
        <KVRow
          label="Hugging Face token"
          value={
            facet.hasHfToken ? (
              <span className="inline-flex items-center gap-2">
                Set
                <Button
                  size="xs"
                  disabled={!canSave.allowed || removing}
                  title={canSave.allowed ? undefined : APPLICATION_SETTINGS_REFUSAL}
                  onClick={remove}
                >
                  Remove token
                </Button>
              </span>
            ) : (
              "Not set"
            )
          }
        />
      </KVList>
    </SettingsCard>
  );
}
