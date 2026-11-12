"use client";

import { Card } from "@/components/console/card";
import { QAList, QARow } from "@/components/console/qa-row";
import { ResourceList } from "@/components/console/resource-list";
import { useInvalidate } from "@/lib/api/use-invalidate";

import { useAiProviders } from "../use-integrations";
import { aiSpec } from "./ai-spec";

/**
 * AI: the providers, and a note saying where the two features that use them
 * live.
 *
 * **The model lookup is inside the provider dialog, not a card here**.
 * As a card it sat behind the dialog's backdrop while the Model field sent
 * people to it, and reaching it meant Cancel, which empties the form —
 * `model-lookup.tsx` has the rest.
 *
 * **The brief is explicit that `suggest` and `analyze-logs` are surfaced where
 * they belong rather than as buttons here**, and this card is what stops that
 * being invisible — an operator who configures a provider and then finds nothing
 * different anywhere has no way to tell whether it worked. So the two consumers
 * are named, with what each one does and where it is.
 */
export function AiSection() {
  const invalidate = useInvalidate();
  const query = useAiProviders();

  return (
    <>
      <ResourceList spec={aiSpec(invalidate.ai)} query={query} />

      <Card>
        <Card.Header
          title="What a provider is used for"
          sub="Two features, neither of them on this screen — they belong beside the work they help with."
          headingLevel={2}
        />
        <Card.Body>
          <QAList>
            <QARow
              title="Drafting a service from a description"
              description="On an Environment's Services tab, “Draft one with AI” takes a sentence and produces up to three complete Compose stacks — the file, its variables, its domains and any config files — and deploying one creates an ordinary Compose stack you own from then on."
            />
            <QARow
              title="Reading a build or container log"
              description="On a Deployment's log, “Explain this log” sends what is on screen and reads back a summary, the errors it found, the likely cause and what to change. The log is sent to the provider you configured, which is worth knowing before you point it at one you do not run."
            />
          </QAList>
        </Card.Body>
      </Card>
    </>
  );
}
