import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Picker } from "@/components/console/picker";
import { Button } from "@/components/ui/button";
import { aiApi } from "@/lib/api/endpoints/ai";
import { errorMessage } from "@/lib/api/error-message";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";

/**
 * **`POST /ai/analyze-logs`, where a log actually is.**
 *
 * The phase brief asks for the two AI features to be surfaced where they belong
 * rather than as buttons on a settings page, and this is the smaller of the two:
 * a build has failed, its output is on the screen, and the question is what went
 * wrong. Anywhere else it would be a feature nobody finds.
 *
 * **It renders nothing at all when no provider is configured**, rather than a
 * control that explains it cannot work. `GET /ai/enabled-providers` is readable
 * by every member (unlike `GET /ai`, which is owner/admin), so this is the one
 * question about AI configuration a normal member can ask. Where to turn it on
 * is said on the AI settings screen, which is where somebody able to do it is.
 *
 * **What is sent is stated before it is sent.** The lines on this screen go to a
 * third party, and a build log routinely holds an image reference, a repository
 * name and occasionally an environment variable that was echoed. That is the
 * operator's decision to make, not something to discover afterwards.
 */
export function ExplainLog({
  lines,
  context,
}: {
  lines: readonly string[];
  /** Which prompt the backend uses — build/deployment, or runtime/container. */
  context: "build" | "runtime";
}) {
  const { organizationId } = useActiveOrganizationId();
  const providers = useQuery({
    queryKey: [...keys.ai.all(organizationId), "enabled"],
    queryFn: () => aiApi.enabled(),
    enabled: organizationId !== null,
  });

  const [aiId, setAiId] = useState("");
  const [pending, setPending] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  const available = providers.data ?? [];
  // Nothing configured, or the read failed — either way there is nothing here
  // worth putting on a build log. A refusal is not reported: this is an
  // enhancement to somebody else's screen and must not add an error to it.
  if (available.length === 0) return null;

  const chosen = aiId || available[0].aiId;
  const text = lines.join("\n");

  async function explain() {
    setRefusal(null);
    setAnalysis(null);
    setPending(true);
    try {
      const result = await aiApi.analyzeLogs({
        aiId: chosen,
        logs: text,
        context,
      });
      setAnalysis(result.analysis);
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="rounded-lg border border-line bg-panel-2 px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <p className="min-w-0 flex-1 basis-50 text-meta text-tx-2">
          Send these {lines.length} {lines.length === 1 ? "line" : "lines"} to
          your AI provider and read back what it thinks went wrong.
        </p>
        {available.length > 1 ? (
          <Picker
            options={available.map((provider) => ({
              value: provider.aiId,
              label: provider.name,
              detail: provider.model,
            }))}
            value={chosen}
            onValueChange={setAiId}
            className="w-auto min-w-40"
          />
        ) : null}
        <Button
          size="sm"
          onClick={explain}
          disabled={pending || lines.length === 0}
          aria-busy={pending || undefined}
        >
          <Icon name="spark" size={14} />
          Explain this log
        </Button>
      </div>

      {refusal ? (
        <p className="mt-2.5 rounded-md border border-bad-line bg-bad-tint px-3 py-2 text-meta wrap-anywhere text-tx">
          {refusal}
        </p>
      ) : null}

      {analysis ? (
        // Deliberately not rendered as Markdown. The model is asked for four
        // headed sections and usually returns them, but a log analysis is prose
        // that may quote a stack trace — and a Markdown renderer here would be a
        // second parser to trust with somebody's build output. Whitespace is
        // preserved so the model's own structure survives.
        <div className="mt-2.5 rounded-md border border-line bg-panel px-3.5 py-3">
          <p className="mb-1.5 text-meta font-semibold text-tx-3">
            {available.find((provider) => provider.aiId === chosen)?.name} said
          </p>
          <p className="text-body whitespace-pre-wrap wrap-anywhere text-tx-2">
            {analysis}
          </p>
        </div>
      ) : null}
    </div>
  );
}
