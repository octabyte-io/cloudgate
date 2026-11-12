import { useState } from "react";
import { useFormContext } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import { aiApi, type AiModel } from "@/lib/api/endpoints/ai";
import { cn } from "@/lib/utils";

import type { AiValues } from "./ai-spec";

/** How many model names are offered at once before the filter has to narrow them. */
const SHOWN = 24;

type Answer =
  | { asked: string; models: AiModel[] }
  | { asked: string; refusal: string };

/**
 * **The Model field's own lookup: list what this endpoint offers, with the URL
 * and key already in the dialog, and pick one**.
 *
 * It was a card of its own under the providers list, and the two pointed at
 * each other across the dialog's backdrop: the Model hint said to use "List
 * models" *below*, which nothing could click while the dialog was open, and
 * the card said to copy a name into the Model field *above*, which was not on
 * screen until the dialog was. The only route between them was Cancel, and
 * Cancel mounts a fresh form (every opening is keyed — `resource-spec.ts`
 * says why), so on a first setup the key was pasted twice and everything else
 * typed twice.
 *
 * **Moved inside rather than making Cancel keep the values.** Cancel meaning
 * "throw this away" is a rule every list in the console shares, and F09 found
 * the defect it prevents; bending it for one dialog would make this the one
 * Cancel that keeps a pasted API key in memory after you said no. And the
 * old card's reason for existing apart — "a saved provider's key never comes
 * back, so there is nothing to ask with" — is true of the *saved* key only.
 * On an add the key is in the form already; on an edit, typing it into the
 * key box is what this asks for, and says so.
 *
 * It is the field's `after`, a block under the Model box, and deliberately not
 * its `hint`: the hint is the input's accessible description, and a button, a
 * filter and two dozen model names read out as "the description of Model" is
 * noise. Reading the form through `useFormContext` is what lets it live in a
 * spec-driven dialog without a new field kind. The list is capped at
 * {@link SHOWN} with a filter, because OpenRouter answers with several hundred.
 *
 * `POST /ai/models` stores nothing, and nothing here is saved either — the
 * dialog's own submit is still the only thing that does.
 */
export function ModelLookup() {
  const form = useFormContext<AiValues>();
  const [apiUrl, apiKey, model] = form.watch(["apiUrl", "apiKey", "model"]);
  const [pending, setPending] = useState(false);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [filter, setFilter] = useState("");

  // An answer is about the URL and key it was asked with; after either
  // changes it is about some other endpoint, so it stops being shown.
  const asking = `${apiUrl.trim()}\n${apiKey}`;
  const current = answer?.asked === asking ? answer : null;

  const blocked =
    apiUrl.trim() === ""
      ? "Fill in the API URL, and the key, to list what that endpoint offers."
      : apiKey === ""
        ? "To list what this endpoint offers, type its API key into the box above — a saved key never comes back to the browser, so there is nothing else to ask with."
        : null;

  async function list() {
    if (blocked !== null || pending) return;
    setPending(true);
    setFilter("");
    try {
      const models = await aiApi.models({ apiUrl: apiUrl.trim(), apiKey });
      setAnswer({ asked: asking, models });
    } catch (error) {
      setAnswer({ asked: asking, refusal: errorMessage(error) });
    } finally {
      setPending(false);
    }
  }

  function pick(id: string) {
    form.setValue("model", id, { shouldDirty: true, shouldValidate: true });
  }

  const models = current && "models" in current ? current.models : null;
  const needle = filter.trim().toLowerCase();
  const matching = models
    ? models.filter((entry) => entry.id.toLowerCase().includes(needle))
    : [];

  return (
    <div className="grid gap-2 text-meta text-tx-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={list}
          disabled={blocked !== null || pending}
          aria-busy={pending || undefined}
        >
          List models
        </Button>
        <span className="min-w-0 flex-1">
          {blocked ??
            "Asks the endpoint above with the key you typed. Nothing is saved until you add the provider."}
        </span>
      </div>
      {current && "refusal" in current ? (
        <p className="text-bad">{current.refusal}</p>
      ) : null}
      {models && models.length === 0 ? (
        <p>
          The endpoint answered and named no models. Some providers do not
          publish a list; the model name still works if you type it in.
        </p>
      ) : null}
      {models && models.length > 0 ? (
        <>
          <p>
            {models.length} {models.length === 1 ? "model" : "models"}. Pick
            one to fill in the Model field.
          </p>
          {models.length > SHOWN ? (
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              // Enter would submit the provider form around this box.
              onKeyDown={(event) => {
                if (event.key === "Enter") event.preventDefault();
              }}
              placeholder="Filter models"
              aria-label="Filter models"
              className="font-mono text-meta md:text-meta"
              spellCheck={false}
              autoComplete="off"
            />
          ) : null}
          <div className="flex flex-wrap gap-1.5">
            {matching.slice(0, SHOWN).map((entry) => (
              <Button
                key={entry.id}
                type="button"
                size="xs"
                variant="qt"
                aria-pressed={entry.id === model}
                onClick={() => pick(entry.id)}
                className={cn(
                  "font-mono",
                  entry.id === model && "bg-raise text-tx",
                )}
              >
                {entry.id}
              </Button>
            ))}
          </div>
          {matching.length > SHOWN ? (
            <p>
              And {matching.length - SHOWN} more — type in the filter to narrow
              them.
            </p>
          ) : matching.length === 0 ? (
            <p>None of them contains “{filter.trim()}”.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
