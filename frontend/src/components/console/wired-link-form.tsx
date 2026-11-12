import { useId, useState } from "react";

import { Picker } from "@/components/console/picker";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import type {
  LinkSource,
  WiredVariable,
} from "@/lib/api/endpoints/wired-variables";

/**
 * Links one variable to another Service's Output: a name, then a source
 * from the ones a plan would accept, then one of that kind's Outputs. The
 * choices come from the API (`sources`), never a list of its own here, so the
 * picker and the plan agree on what a link may name.
 *
 * A name that already holds a typed value is switched to the link, and the
 * typed value is dropped — a variable has one source. The form says so, as
 * the plan line will ("typed value → pg-1.url"), before the Save.
 */
export function LinkForm({
  sources,
  typedNames,
  linkedNames,
  save,
  onDone,
}: {
  sources: readonly LinkSource[];
  /** The names the Service's own variables give a typed value. */
  typedNames: readonly string[];
  /** The names already linked, which a new link may not take. */
  linkedNames: readonly string[];
  save: (link: WiredVariable) => Promise<unknown>;
  onDone: () => void;
}) {
  const id = useId();
  const [name, setName] = useState("");
  const [source, setSource] = useState("");
  const [output, setOutput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chosen = sources.find((one) => one.configName === source);
  const trimmed = name.trim();
  const nameProblem =
    trimmed === ""
      ? null
      : /[\s=]/.test(trimmed)
        ? "A variable name has no spaces and no “=”."
        : linkedNames.includes(trimmed)
          ? `${trimmed} is linked already; unlink it first.`
          : null;
  const replacesTyped = trimmed !== "" && typedNames.includes(trimmed);
  const ready =
    trimmed !== "" &&
    nameProblem === null &&
    chosen !== undefined &&
    output !== "";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setPending(true);
    setError(null);
    try {
      await save({ name: trimmed, source, output });
      toast.done(`${trimmed} is linked to ${source}.${output}.`, {
        description: "Deploy for the running container to get it.",
      });
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={submit}
      className="grid gap-3.5"
      aria-label="Link a variable"
    >
      <div className="grid gap-1.5">
        <label htmlFor={`${id}-name`} className="text-body font-medium text-tx">
          Variable
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="DATABASE_URL"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="font-mono"
          aria-invalid={nameProblem !== null}
        />
        {nameProblem ? (
          <p className="text-meta text-bad" role="alert">
            {nameProblem}
          </p>
        ) : null}
      </div>

      <div className="grid gap-3.5 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <label
            htmlFor={`${id}-source`}
            className="text-body font-medium text-tx"
          >
            From Service
          </label>
          <Picker
            id={`${id}-source`}
            options={sources.map((one) => ({
              value: one.configName,
              label: one.configName,
              detail: one.kind,
            }))}
            value={source}
            onValueChange={(next) => {
              setSource(next);
              setOutput("");
            }}
            placeholder="Choose a Service"
            mono
          />
        </div>
        <div className="grid gap-1.5">
          <label
            htmlFor={`${id}-output`}
            className="text-body font-medium text-tx"
          >
            Output
          </label>
          <Picker
            id={`${id}-output`}
            options={(chosen?.outputs ?? []).map((one) => ({
              value: one,
              label: one,
            }))}
            value={output}
            onValueChange={setOutput}
            placeholder={chosen ? "Choose an Output" : "Choose a Service first"}
            disabled={!chosen}
            mono
          />
        </div>
      </div>

      {replacesTyped ? (
        <p className="text-meta text-warn" role="status">
          {trimmed} has a typed value. Saving replaces it with the link —{" "}
          <span className="font-mono">
            typed value →{" "}
            {chosen && output ? `${source}.${output}` : "the link"}
          </span>{" "}
          — and the typed value is removed.
        </p>
      ) : null}

      <p className="text-meta text-tx-2">
        Saving writes the link into the Project config and records it as an
        applied plan. The value is filled in at each deploy and never shown.
      </p>

      {error ? (
        <p className="text-meta text-bad" role="alert">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="pri" disabled={!ready || pending}>
          {replacesTyped ? "Replace typed value with link" : "Save link"}
        </Button>
        <Button type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
