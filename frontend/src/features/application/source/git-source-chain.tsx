import { Controller, useFormContext } from "react-hook-form";

import { Field } from "@/components/console/field";
import { Picker } from "@/components/console/picker";
import type { SourceRepository } from "@/lib/api/endpoints/git-providers";

import type { GitProviderSpec } from "./providers";
import { RepositoryPicker } from "./repository-picker";
import type { GitSourceValues } from "./git-source-values";
import type { useBranches, useRepositories } from "@/lib/api/use-git-source";

/**
 * The chain: connection → repository → branch.
 *
 * Each step waits for the one above it, and **each one clears what is below it** —
 * a branch from the previous repository is a value the provider would refuse and
 * the form would happily submit. The clearing is here because it is a fact about
 * these three fields; which queries re-run is the parent's business, which is why
 * the two choices the requests depend on are handed back up rather than held here.
 */
export function GitSourceChain({
  spec,
  options,
  connection,
  repositories,
  repository,
  branches,
  onConnection,
  onRepository,
  locked,
}: {
  spec: GitProviderSpec;
  options: readonly { id: string; name: string }[];
  /** The connection the requests are currently reading. */
  connection: string;
  repositories: ReturnType<typeof useRepositories>;
  /** Resolved from this session's click or from the loaded row. */
  repository: SourceRepository | null;
  branches: ReturnType<typeof useBranches>;
  onConnection: (id: string) => void;
  onRepository: (repository: SourceRepository) => void;
  /**
   * Why the repository is not this form's to change: it stays the one
   * saved, through whichever connection reaches it, and so does its branch
   * list's question.
   */
  locked?: string;
}) {
  const form = useFormContext<GitSourceValues>();

  return (
    <>
      <Field
        name="connection"
        label={`${spec.label} connection`}
        hint={`Which connected ${spec.label} account this Application clones through.`}
        manual
      >
        <Controller
          name="connection"
          control={form.control}
          render={({ field }) => (
            <Picker
              options={options.map((option) => ({
                value: option.id,
                label: option.name,
              }))}
              value={field.value}
              onValueChange={(next) => {
                field.onChange(next);
                onConnection(next);
                // A repository belongs to a connection, so both choices below
                // are stale the moment this one changes — unless the file
                // fixes the repository, which another connection can reach.
                if (locked) return;
                form.setValue("repository", "");
                form.setValue("branch", "");
              }}
              placeholder={`Choose a ${spec.label} connection`}
            />
          )}
        />
      </Field>

      <Field
        name="repository"
        label={spec.noun === "project" ? "Project" : "Repository"}
        hint={`The ${spec.noun} whose code is built. Search by owner or name.`}
        manual
      >
        <Controller
          name="repository"
          control={form.control}
          render={({ field }) => (
            <RepositoryPicker
              repositories={repositories.data}
              pending={repositories.isPending && connection !== ""}
              waiting={connection === ""}
              error={repositories.error}
              chosen={repository}
              noun={spec.noun}
              plural={spec.plural}
              onChoose={(next) => {
                onRepository(next);
                field.onChange(next.key);
                form.setValue("branch", "");
              }}
              onRefresh={() => void repositories.refetch()}
              locked={
                locked ? { reason: locked, current: field.value } : undefined
              }
            />
          )}
        />
      </Field>

      <Field
        name="branch"
        label="Branch"
        hint="The branch a push deploys from."
        manual
      >
        <Controller
          name="branch"
          control={form.control}
          render={({ field }) => (
            <Picker
              mono
              options={(branches.data ?? []).map((branch) => ({
                value: branch.name,
                label: branch.name,
                detail: branch.commitSha.slice(0, 7),
              }))}
              value={field.value}
              onValueChange={field.onChange}
              pending={branches.isPending && repository !== null}
              disabled={repository === null}
              placeholder={
                repository === null
                  ? `Choose a ${spec.noun} first`
                  : "Choose a branch"
              }
            />
          )}
        />
      </Field>
    </>
  );
}
