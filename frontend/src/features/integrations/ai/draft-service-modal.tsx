import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Field } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Picker } from "@/components/console/picker";
import { Stepper } from "@/components/console/stepper";
import { toast } from "@/components/console/toast";
import { aiApi, type AiSuggestion } from "@/lib/api/endpoints/ai";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import type { DeployTarget } from "@/lib/api/endpoints/environments";
import { useServers } from "@/lib/api/use-servers";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { settingsHref } from "@/lib/settings/sections";
import { useCreateServerPicker } from "@/lib/forms/create-server-picker";

import { DraftFooter } from "./draft-footer";
import { serviceCount } from "./draft-service-count";
import { DescribeStep, ReviewStep } from "./draft-steps";

/**
 * **`POST /ai/suggest` and `POST /ai/deploy`, where a service is created.**
 *
 * The brief's endpoint audit asks whether `/ai/deploy` belongs in this phase or
 * in F09's, and its DTO answers: it takes an `environmentId` and a
 * `dockerCompose`, and it calls `compose.createByTemplate` with `sourceType:
 * "raw"` plus the domains and file mounts the suggestion came with. It creates a
 * **Compose stack**, so it belongs beside "Add a Compose stack" — which is on
 * F08's Services tab, where F11 and F12 already put theirs.
 *
 * Three steps, because there are three decisions and conflating them is how a
 * generated stack gets deployed unread: describe what is wanted, choose one of up
 * to three complete stacks, and **read the file** before it becomes a service on
 * your Server. The first and third are `draft-steps.tsx`; what stays here is the
 * step machine and the two requests.
 *
 * What it creates is an **ordinary Compose stack**: `sourceType: "raw"` with the
 * file stored, isolated on its own network, not deployed. So the thing this
 * produces is a stack somebody owns and edits, not a black box.
 */
const STEP_IDS = ["describe", "choose", "read"] as const;

/** Where a provider is added or turned back on — named and reached in one. */
const AI_SETTINGS = (
  <Link
    href={settingsHref("ai")}
    className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
  >
    Settings → AI
  </Link>
);

export function DraftServiceModal({
  environmentId,
  environmentName,
  deployTarget,
  open,
  onOpenChange,
}: {
  environmentId: string;
  environmentName: string;
  /** Where the Environment deploys: a cloud one asks for a Server. */
  deployTarget: DeployTarget;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const invalidate = useInvalidate();
  const { organizationId } = useActiveOrganizationId();

  const providers = useQuery({
    queryKey: [...keys.ai.all(organizationId), "enabled"],
    queryFn: () => aiApi.enabled(),
    enabled: organizationId !== null && open,
  });

  /**
   * Why there is a second read, and why it is allowed to come back refused.
   *
   * `GET /ai/enabled-providers` answers the enabled rows and nothing else, so
   * an empty answer covers two states that want opposite advice: no provider
   * has ever been configured, and every provider there is has been switched off
   * with **Available to use**. The second one was being told to go and add a
   * provider, on the very screen that was already showing theirs reading
   * "Turned off".
   *
   * `GET /ai` is the count of *all* of them, so it separates the two — and it
   * is owner/admin only (`AiService.ensureOwnerOrAdmin`), which is exactly the
   * caller the advice is addressed to: nobody else can add a provider or turn
   * one on. A member's refusal therefore falls back to the sentence that was
   * always there, rather than being read as an empty list (§3.5) — it is the
   * one this screen cannot improve on for them.
   */
  const configured = useQuery({
    queryKey: keys.ai.list(organizationId),
    queryFn: () => aiApi.list(),
    enabled: organizationId !== null && open,
  });

  const [aiId, setAiId] = useState("");
  const [input, setInput] = useState("");
  const [asking, setAsking] = useState(false);
  const [suggestions, setSuggestions] = useState<AiSuggestion[] | null>(null);
  const [chosen, setChosen] = useState<AiSuggestion | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // Where the stack goes: `""` is this Cloudgate host, sent as `null`. On the
  // Hosted instance the host is not offered, and in a cloud Environment it is
  // a choice of its own, so there `""` is no choice yet and the route
  // refuses it with its own sentence (ADR-0053 seam 4).
  const servers = useServers();
  const picker = useCreateServerPicker(deployTarget);
  const [serverId, setServerId] = useState("");
  const chosenServer = picker.serverIdOf(serverId);

  const available = providers.data ?? [];
  const provider = aiId || available[0]?.aiId || "";
  const step = chosen ? 2 : suggestions ? 1 : 0;
  // Nothing enabled and something configured is the all-switched-off state.
  const switchedOff = available.length === 0 ? (configured.data ?? []) : [];

  async function ask() {
    setRefusal(null);
    setAsking(true);
    try {
      const result = await aiApi.suggest({
        aiId: provider,
        input: input.trim(),
      });
      setSuggestions(result);
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setAsking(false);
    }
  }

  async function deploy() {
    if (!chosen) return;
    setRefusal(null);
    setDeploying(true);
    try {
      const created = await aiApi.deploy({
        environmentId,
        id: chosen.id,
        name: chosen.name,
        description: chosen.shortDescription,
        dockerCompose: chosen.dockerCompose,
        // The route takes the variables as one dotenv blob, not as the array
        // the suggestion carries — same column an Environment's variables use.
        envVariables: chosen.envVariables
          .map((variable) => `${variable.name}=${variable.value}`)
          .join("\n"),
        domains: chosen.domains,
        configFiles: chosen.configFiles ?? undefined,
        ...(chosenServer === undefined ? {} : { serverId: chosenServer }),
      });
      await invalidate.compose({ environmentId });
      toast.done(`${chosen.name} created.`, {
        description: "It is not deployed yet — read its file, then deploy.",
      });
      onOpenChange(false);
      router.push(`/compose/${created.composeId}`);
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setDeploying(false);
    }
  }

  return (
    <Modal wide open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Draft a stack with AI"
        description={`Describe what you need and your AI provider writes a complete compose file. It is created in ${environmentName} as an ordinary Compose stack, and nothing is deployed until you deploy it.`}
      />
      <Modal.Body>
        <Stepper
          label="Draft a stack with AI"
          steps={[
            { id: "describe", label: "Describe", done: step > 0 },
            { id: "choose", label: "Choose", done: step > 1 },
            { id: "read", label: "Read the file" },
          ]}
          currentId={STEP_IDS[step]}
        />

        {available.length === 0 ? (
          // Not an error: most Organizations have no AI provider, and this is a
          // statement about configuration rather than about a failed request.
          // Two configurations, two different things to go and do — the one
          // sentence used to cover both and only described one of them.
          //
          // The section is a link in all three: it was plain text naming
          // "Organization settings", which is not what the strip is called.
          <p className="text-body text-tx-2">
            {switchedOff.length === 1 ? (
              <>
                {switchedOff[0].name} is turned off. Turn it back on under{" "}
                {AI_SETTINGS}, then come back — nothing else on this screen
                changes.
              </>
            ) : switchedOff.length > 1 ? (
              <>
                All {switchedOff.length}{" "}
                of this Organization&rsquo;s AI providers are turned off. Turn one
                back on under {AI_SETTINGS}, then come back — nothing else on this
                screen changes.
              </>
            ) : (
              <>
                No AI provider is available. Add one under {AI_SETTINGS}, then
                come back — nothing else on this screen changes.
              </>
            )}
          </p>
        ) : step === 0 ? (
          <DescribeStep
            available={available}
            provider={provider}
            onProvider={setAiId}
            input={input}
            onInput={setInput}
          />
        ) : step === 1 && suggestions ? (
          <PickGrid label="Suggestions">
            {suggestions.map((suggestion) => (
              <PickCard
                key={suggestion.id}
                icon="box"
                title={suggestion.name}
                description={suggestion.shortDescription}
                meta={serviceCount(suggestion.dockerCompose)}
                onClick={() => setChosen(suggestion)}
              />
            ))}
          </PickGrid>
        ) : chosen ? (
          <>
            <ReviewStep chosen={chosen} />
            <Field
              name="serverId"
              label="Server"
              manual
              optional={picker.optional}
              hint={picker.hint(
                "Which host the stack runs on.",
                "Which of your Servers the stack runs on.",
              )}
              error={servers.error ? errorMessage(servers.error) : undefined}
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
        ) : null}

        {refusal ? (
          <p className="rounded-md border border-bad-line bg-bad-tint px-3 py-2.5 text-meta wrap-anywhere text-tx">
            {refusal}
          </p>
        ) : null}
      </Modal.Body>
      <DraftFooter
        step={step}
        asking={asking}
        deploying={deploying}
        canAsk={input.trim().length >= 3 && available.length > 0}
        onBack={() => {
          setRefusal(null);
          if (chosen) setChosen(null);
          else setSuggestions(null);
        }}
        onAsk={ask}
        onDeploy={deploy}
      />
    </Modal>
  );
}
