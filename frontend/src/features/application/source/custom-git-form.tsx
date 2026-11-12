import { Controller, FormProvider } from "react-hook-form";
import { z } from "zod";

import { Field, FormError } from "@/components/console/field";
import { lockedProps } from "@/components/console/resource-field";
import { Picker } from "@/components/console/picker";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  DEFAULT_GIT_BRANCH,
  GIT_CLONE_URL,
  GIT_CLONE_URL_MESSAGE,
} from "@/lib/forms/git-url";
import {
  BUILD_PATH,
  fieldText,
  type PathSpec,
  type SourceRow,
} from "./providers";

import { useSshKeys } from "../use-application";

const schema = z.object({
  customGitUrl: z
    .string()
    .trim()
    .min(1, "Give the repository's clone URL.")
    .regex(GIT_CLONE_URL, GIT_CLONE_URL_MESSAGE),
  customGitBranch: z.string().trim().min(1, "Name the branch to build."),
  customGitBuildPath: z.string(),
  customGitSSHKeyId: z.string(),
  enableSubmodules: z.boolean(),
});
type Values = z.infer<typeof schema>;

/**
 * A git repository nothing is connected to — the `git` source type.
 *
 * The four connected providers know their own repositories and branches, so those
 * are pickers. This one cannot: the URL is whatever the operator types, so the
 * branch is a text field too, and the first thing that tells them they got it
 * wrong is the clone step of a Deployment. That is a real difference in kind, and
 * the hints say so rather than pretending the two forms are the same.
 *
 * The SSH key is optional because a public repository over HTTPS needs none. The
 * list comes from `GET /ssh-keys`, which **also returns every private key**
 * — the typed client
 * declares only the four fields this picker reads, so nothing here can render one.
 */
export function CustomGitForm({
  row,
  path = BUILD_PATH,
  save,
  onDone,
  locked,
}: {
  row: SourceRow;
  /** See `GitSourceForm` — a Compose stack saves its `composePath` here instead. */
  path?: PathSpec;
  save: (input: Record<string, unknown>) => Promise<unknown>;
  onDone: () => void;
  /** See `GitSourceForm`: the URL and the path are the file's. */
  locked?: string;
}) {
  const keys = useSshKeys();

  const form = useApiForm<Values>({
    schema,
    defaultValues: {
      customGitUrl: row.customGitUrl ?? "",
      // A real value, not a placeholder: the field looked filled with `main`
      // and the save refused it as empty.
      customGitBranch: row.customGitBranch || DEFAULT_GIT_BRANCH,
      customGitBuildPath:
        fieldText(row, path.customGitColumn) || path.fallback,
      customGitSSHKeyId: row.customGitSSHKeyId ?? "",
      enableSubmodules: row.enableSubmodules,
    },
    onSubmit: async (values) => {
      await save({
        sourceType: "git",
        customGitUrl: values.customGitUrl.trim(),
        customGitBranch: values.customGitBranch,
        [path.customGitColumn]:
          values.customGitBuildPath.trim() || path.fallback,
        customGitSSHKeyId: values.customGitSSHKeyId || null,
        enableSubmodules: values.enableSubmodules,
      });
      toast.done("Source saved.", {
        description: "The next Deployment clones it.",
      });
      onDone();
    },
    onError: (error) => toast.error(error),
  });

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
        <Field
          name="customGitUrl"
          label="Clone URL"
          hint="Over SSH with a key below, or over HTTPS for a public repository."
        >
          <Input
            placeholder="git@git.example.com:acme/api.git"
            {...lockedProps(locked)}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-meta md:text-meta"
          />
        </Field>

        <Field
          name="customGitBranch"
          label="Branch"
          hint="Typed, not chosen — nothing here can list this repository's branches. Starts on main; change it if the repository's default branch is another."
        >
          <Input
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-meta md:text-meta"
          />
        </Field>

        <Field
          name="customGitBuildPath"
          label={path.label}
          hint={path.hint}
        >
          <Input
            placeholder={path.placeholder}
            {...lockedProps(locked)}
            autoComplete="off"
            spellCheck={false}
          />
        </Field>

        <Field
          name="customGitSSHKeyId"
          label="SSH key"
          optional
          hint="The key that clones. Not needed for a public HTTPS URL."
          manual
        >
          <Controller
            name="customGitSSHKeyId"
            control={form.control}
            render={({ field }) => (
              <Picker
                // "Clone over HTTPS" is an **option**, not only the placeholder.
                // As a placeholder it showed only while nothing was
                // chosen, so a saved key could never be unlinked from here —
                // and a linked key keeps counting as used wherever key usage is
                // shown. `""` is the Picker's none; the save turns it into `null`.
                options={[
                  { value: "", label: "Clone over HTTPS" },
                  ...(keys.data ?? []).map((key) => ({
                    value: key.sshKeyId,
                    label: key.name,
                    detail: key.description ?? undefined,
                  })),
                ]}
                value={field.value}
                onValueChange={field.onChange}
                pending={keys.isPending}
                placeholder="Clone over HTTPS"
              />
            )}
          />
        </Field>

        <Field
          name="enableSubmodules"
          label="Clone submodules"
          hint="Fetch the repository's submodules as well. Off unless the build needs them."
          orientation="horizontal"
          manual
        >
          <Controller
            name="enableSubmodules"
            control={form.control}
            render={({ field }) => (
              <Switch
                checked={field.value}
                onCheckedChange={(next) => field.onChange(next)}
              />
            )}
          />
        </Field>

        <FormError message={form.rootError} />

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton pending={form.formState.isSubmitting}>
            Save source
          </SubmitButton>
          <Button type="button" onClick={onDone}>
            Cancel
          </Button>
        </div>
      </form>
    </FormProvider>
  );
}
