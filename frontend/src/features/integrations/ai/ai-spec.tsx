import { z } from "zod";

import { Chip } from "@/components/console/chip";
import type { Column } from "@/components/console/data-table";
import type { ResourceSpec } from "@/components/console/resource-spec";
import { aiApi, type AiProvider } from "@/lib/api/endpoints/ai";
import { TONE_FILL } from "@/lib/design/status";
import { cn } from "@/lib/utils";

import { ModelLookup } from "./model-lookup";
import { example } from "@/components/console/form-spec";

/**
 * An AI provider, as a `ResourceSpec`.
 *
 * **The model field is a plain text box and not a picker, and that is the
 * honest control.** `POST /ai/models` needs the API key, the key never comes
 * back, and a `Picker` that could only be filled in on a *create* would be an
 * empty select on every edit — F09's third defect, where "no options" and "not
 * asked yet" rendered the same. The models this provider offers are listed
 * *under* the field by `ModelLookup` (its `after`, not its hint), from a call the person triggers
 * with the URL and key already in this dialog, and picking one fills the box in.
 *
 * The provider is sniffed from the URL by `select-ai-provider.ts` — OpenAI,
 * Azure, Anthropic, Cohere, Perplexity, Mistral, Ollama, DeepInfra, Gemini,
 * OpenRouter, Z.ai, MiniMax, or an OpenAI-compatible fallback. There is no
 * provider field to fill in and no list to keep in step with theirs.
 */

const schema = z.object({
  /**
   * Which saved provider this form is editing, or `""` on an add.
   *
   * Not a control — no `FieldSpec` names it, so nothing renders it. It is in the
   * values because `ResourceList` builds one spec for both dialogs and hands
   * `test.run` the values and nothing else, and a test against a saved provider
   * needs the id.
   */
  aiId: z.string(),
  name: z.string().min(1, "A provider needs a name."),
  apiUrl: z.url("Give the full API URL, including https://"),
  apiKey: z.string(),
  model: z.string().min(1, "A model is needed."),
  isEnabled: z.boolean(),
});

export type AiValues = z.infer<typeof schema>;

export const aiColumns: Column<AiProvider>[] = [
  {
    id: "name",
    head: "Name",
    tone: "key",
    compare: (a, b) => a.name.localeCompare(b.name),
    cell: (row) => row.name,
  },
  {
    id: "model",
    head: "Model",
    cell: (row) => <Chip variant="mono">{row.model}</Chip>,
  },
  {
    id: "apiUrl",
    head: "Endpoint",
    tone: "wrap",
    cell: (row) => <span className="font-mono text-meta">{row.apiUrl}</span>,
  },
  {
    id: "isEnabled",
    head: "In use",
    cell: (row) => (
      <span className="inline-flex items-center gap-1.75 whitespace-nowrap">
        <span
          aria-hidden="true"
          className={cn(
            "inline-block size-2 rounded-pill",
            TONE_FILL[row.isEnabled ? "ok" : "mute"],
          )}
        />
        {row.isEnabled ? "Yes" : "Turned off"}
      </span>
    ),
    compare: (a, b) => Number(b.isEnabled) - Number(a.isEnabled),
  },
];

export function aiSpec(
  onDone: () => Promise<unknown>,
): ResourceSpec<AiProvider, AiValues> {
  return {
    noun: "provider",
    plural: "providers",
    title: "AI providers",
    lede: "An OpenAI-compatible endpoint. Cloudgate works out which provider it is from the URL, so anything speaking that API works — including one you run yourself.",
    icon: "spark",
    addLabel: "Add a provider",
    emptyTitle: "No AI providers yet",
    emptyBody:
      "Add one to draft a Compose stack from a description, and to have a failed build's log read back to you in English.",
    tableLabel: "AI providers",

    columns: aiColumns,
    getRowId: (row) => row.aiId,
    rowName: (row) => row.name,
    defaultSort: { id: "name", dir: "asc" },

    schema,
    fields: [
      {
        name: "name",
        label: "Name",
        kind: "text",
        placeholder: example("OpenAI"),
        hint: "What this provider is called in Cloudgate. Only you see it.",
      },
      {
        name: "apiUrl",
        label: "API URL",
        kind: "text",
        mono: true,
        placeholder: "https://api.openai.com/v1",
        hint: "The base URL, the one you would put in an OpenAI client. Ollama is http://localhost:11434.",
      },
      {
        name: "apiKey",
        label: "API key",
        kind: "password",
        hint: "Stored encrypted and never shown again. Leave it empty when editing to keep the one already saved — a test then uses the stored one.",
      },
      {
        name: "model",
        label: "Model",
        kind: "text",
        mono: true,
        placeholder: example("gpt-4o-mini"),
        hint: "Exactly as the provider spells it. List models, under this box, asks the endpoint above and fills it in.",
        after: <ModelLookup />,
      },
      {
        name: "isEnabled",
        label: "Available to use",
        kind: "switch",
        hint: "Turn it off to keep the configuration and stop it being offered.",
      },
    ],

    toDefaults: (row) => ({
      aiId: row?.aiId ?? "",
      name: row?.name ?? "",
      apiUrl: row?.apiUrl ?? "",
      apiKey: "",
      model: row?.model ?? "",
      isEnabled: row?.isEnabled ?? true,
    }),

    test: {
      label: "Test connection",
      // Only an *add* with an empty key box has nothing to authenticate with. On
      // an edit the row itself holds the key, so the button stays on.
      blocked: (values) =>
        !values.aiId && !values.apiKey
          ? "Fill in the API key and the test sends one token through the model with it. Nothing is saved yet, so there is nothing else to authenticate with."
          : // The test sends the model on screen, and with none the backend
            // answered in zod's own words.
            values.apiKey && !values.model.trim()
            ? "Fill in the model and the test sends one token through it."
            : null,
      // A real generation either way: the backend asks the model to reply with
      // "ok" and fails if nothing comes back. So this proves the URL, the key
      // *and* that the model name is one this endpoint will actually serve.
      run: async (values) => {
        if (values.apiKey) {
          const result = await aiApi.testConnection({
            apiUrl: values.apiUrl,
            apiKey: values.apiKey,
            model: values.model,
          });
          return `${values.model} answered with the key you typed. ${result.message}`;
        }
        // The stored URL, key and model — not the ones on screen.
        const result = await aiApi.testSavedConnection(values.aiId);
        return `This provider answered as it is saved. ${result.message} Anything changed in this dialog was not part of that — save it, or type the API key in to test these values instead.`;
      },
    },

    // No statement names these: `AiService.ensureOwnerOrAdmin` gates
    // the list and all three writes alike, so a refused list is the answer
    // for Add, Edit and Remove too — see `usePermission`'s rule, case 2.
    permissions: "same-as-list",
    create: async (values) => {
      await aiApi.create({
        name: values.name,
        apiUrl: values.apiUrl,
        apiKey: values.apiKey,
        model: values.model,
        isEnabled: values.isEnabled,
      });
      await onDone();
    },

    update: async (row, values) => {
      await aiApi.update(row.aiId, {
        name: values.name,
        apiUrl: values.apiUrl,
        model: values.model,
        isEnabled: values.isEnabled,
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
      });
      await onDone();
    },

    remove: async (row) => {
      await aiApi.remove(row.aiId);
      await onDone();
    },

    deleteNote: (row) => (
      <>
        <strong className="font-medium text-tx">{row.name}</strong> stops being
        offered, and the key Cloudgate holds for it is deleted. Nothing already
        created from a suggestion is affected — a Compose stack drafted this way
        is an ordinary stack once it exists.
      </>
    ),
  };
}
