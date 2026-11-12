"use client";

import { LinkButton } from "@/components/console/link-button";
import { Outcome } from "@/components/console/outcome";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { TabPending } from "@/components/console/tab-pending";
import { TAKES_HF_TOKEN } from "@/lib/api/endpoints/applications";
import { errorMessage } from "@/lib/api/error-message";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { ModelConnectCard } from "../model/model-connect-card";
import { ModelHfTokenCard } from "../model/model-hf-token-card";
import { ModelSettingsCard } from "../model/model-settings-card";
import { TokenSpendCard } from "../model/token-spend-card";
import { useApplication, useUpdateApplication } from "../use-application";

/**
 * An AI model's Model tab, second after Overview and only on an AI
 * model (`tabs/application.ts`). This cut is its settings; the rail never
 * offers it on a plain Application, and the shell answers a visit to it there
 * before this renders (`scope-panel.tsx`). Under the settings, how a client
 * calls it and who can, and who has spent what on it.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const row = application.data;
  const update = useUpdateApplication(id, row?.environmentId);

  if (application.error) {
    return (
      <Outcome
        tone="bad"
        icon="cpu"
        title="This AI model could not be read"
        action={<LinkButton href="/projects">Back to Projects</LinkButton>}
      >
        {errorMessage(application.error)}
      </Outcome>
    );
  }

  if (!row?.aiModel) return <TabPending />;

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="Which model this AI model serves, on which inference runtime and image, how a client calls it, and who spends what on it."
      />
      <ModelSettingsCard
        application={row}
        facet={row.aiModel}
        save={(input) => update.mutateAsync(input as never)}
      />
      {/* vLLM's and llama.cpp's alone: Ollama fetches no gated weights. */}
      {TAKES_HF_TOKEN[row.aiModel.runtime] ? (
        <ModelHfTokenCard
          facet={row.aiModel}
          save={(input) => update.mutateAsync(input as never)}
        />
      ) : null}
      <ModelConnectCard application={row} facet={row.aiModel} />
      <TokenSpendCard applicationId={row.applicationId} />
    </Page>
  );
}
