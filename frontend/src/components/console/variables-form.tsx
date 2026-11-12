import { FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

import type { NameLock } from "@/components/console/config-lock";
import { countVariables, parseEnvBlob } from "@/lib/format/env-blob";
import {
  envIssues,
  type EnvIssue,
  type ReferenceSources,
} from "@/lib/format/env-lint";
import { cn } from "@/lib/utils";
import { agreeing, counted } from "@/lib/format/plural";

const schema = z.object({ env: z.string() });
type Values = z.infer<typeof schema>;

/**
 * The blob, as a block.
 *
 * One textarea and no per-variable rows, because the endpoint takes the whole
 * column: `PATCH /environments/:id` and `PATCH /projects/:id` both accept
 * `{ env }` and nothing finer. Editing a parsed row and reassembling the text
 * would quietly reorder — and eventually lose — the comments in it.
 *
 * It is **mounted only while editing**, which is what keeps it in step with the
 * query behind it: react-hook-form reads `defaultValues` once, so a form that
 * outlived a refetch would keep offering to save a blob that had since changed
 * underneath it.
 */
export function VariablesForm({
  env,
  save,
  onDone,
  noun,
  names = null,
  references,
}: {
  env: string;
  save: (next: string) => Promise<unknown>;
  onDone: () => void;
  /** What this blob belongs to, for the toast: "Project", "Environment". */
  noun: string;
  /**
   * The names this blob may hold, when something else sets them (a
   * repository-kept Project config's variable lists). Values stay editable;
   * a new name is said beside the field and the Save is off until it goes.
   */
  names?: NameLock | null;
  /**
   * What this blob's `${{…}}` references can name, for a Service's own
   * variables. Left out for a Project's or an Environment's, whose
   * references nothing resolves.
   */
  references?: ReferenceSources;
}) {
  const form = useApiForm<Values>({
    schema,
    defaultValues: { env },
    onSubmit: async (values) => {
      await save(values.env);
      // The count was computed and the sentence around it was not, so saving one
      // variable said "1 variables are now set here"
      // Two words
      // have to agree with the number, not one, which is why both go through
      // `lib/format/plural.ts` rather than a ternary written here.
      const set = countVariables(values.env);
      toast.done(`${noun} variables saved.`, {
        description: `${counted(set, "variable", "variables")} ${agreeing(set, "is", "are")} now set here.`,
      });
      onDone();
    },
    onError: (error) => toast.error(error),
  });

  const typed = form.watch("env");
  const issues = envIssues(typed, references);
  const blocked = issues.some((issue) => issue.blocking);
  const added =
    names === null
      ? []
      : parseEnvBlob(typed)
          .map((variable) => variable.key)
          .filter((key) => !names.allowed.has(key));

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
        <Field
          name="env"
          label="Variables"
          hint="One KEY=value per line. Lines starting with # are comments and are kept."
        >
          <Textarea
            rows={10}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="max-h-log resize-y overflow-auto font-mono text-meta leading-log"
          />
        </Field>
        <EnvIssues issues={issues} />
        {added.length > 0 ? (
          <p className="text-meta text-bad" role="alert">
            {added.join(", ")}: {names?.refusal}
          </p>
        ) : null}
        <FormError message={form.rootError} />
        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton
            pending={form.formState.isSubmitting}
            disabled={added.length > 0 || blocked}
          >
            Save variables
          </SubmitButton>
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}

/**
 * The block's problems, each beside its line number: a textarea has
 * no gutter to mark, so the list names the line the editor would. A problem
 * that stops the save is `text-bad`; a reference a deploy could not fill is a
 * warning and does not stop it.
 */
function EnvIssues({ issues }: { issues: EnvIssue[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="grid gap-1 text-meta" aria-label="Problems in these lines">
      {issues.map((issue) => (
        <li
          key={`${issue.line}:${issue.message}`}
          className={cn(issue.blocking ? "text-bad" : "text-warn")}
        >
          <span className="font-mono">Line {issue.line}</span>
          {issue.blocking ? "" : " (warning)"}: {issue.message}
        </li>
      ))}
    </ul>
  );
}
