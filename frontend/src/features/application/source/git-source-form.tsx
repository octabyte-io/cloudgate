import { useState } from "react";
import { FormProvider } from "react-hook-form";

import { FormError } from "@/components/console/field";
import { Skeleton } from "@/components/console/skeleton";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useApiForm } from "@/components/console/use-api-form";
import { Button } from "@/components/ui/button";
import type { SourceRepository } from "@/lib/api/endpoints/git-providers";
import { errorMessage } from "@/lib/api/error-message";

import { GitSourceBuildFields } from "./git-source-build-fields";
import { GitSourceChain } from "./git-source-chain";
import {
  gitSourceSchema,
  repositoryKeyOf,
  sourceInput,
  type GitSourceValues,
} from "./git-source-values";
import { NoConnection } from "./no-connection";
import {
  BUILD_PATH,
  fieldText,
  pushCanDeploy,
  type GitProviderSpec,
  type PathSpec,
  type SourceRow,
} from "./providers";
import {
  connectionOptions,
  useBranches,
  useGitConnections,
  useRepositories,
} from "@/lib/api/use-git-source";

/**
 * **One form for all four git providers.**
 *
 * GitHub, GitLab, Bitbucket and Gitea differ in which columns hold the answer and
 * in how their branches route addresses a repository — both captured in
 * `providers.ts` and `endpoints/git-providers.ts`. Everything a person does here
 * is identical, so writing this four times would mean fixing every bug four
 * times and finding it in three.
 *
 * The chain is connection → repository → branch (`git-source-chain.tsx`), and each
 * step waits for the one above it. What stays here is the part that is neither a
 * field nor a provider difference: the three queries, the mapping from a chosen
 * repository back onto whichever columns this provider names, and the two gates
 * that decide whether the form is shown at all.
 *
 * **It serves a Compose stack too** (F12), because a `compose` row holds the same
 * git columns under the same names. One prop is different — `path` — and
 * `PathSpec` in `providers.ts` says why.
 */
export function GitSourceForm({
  row,
  spec,
  path = BUILD_PATH,
  save,
  onDone,
  locked,
}: {
  row: SourceRow;
  spec: GitProviderSpec;
  /**
   * Why the repository and the path are not this form's to change: a
   * repository-kept Project config describes this Application. The
   * connection and the branch stay Cloudgate's, so the form still opens.
   */
  locked?: string;
  /**
   * Which column the path field writes, and what to call it. Defaults to an
   * Application's per-provider build path; F12 passes the Compose stack's
   * `composePath`, which is the only thing about this form that differs between
   * the two rows.
   */
  path?: PathSpec;
  /**
   * Loosely typed on purpose: the two `update` DTOs this saves into are different
   * shapes, and the provider spec is what decides which columns are named. A
   * narrower type here would have to be a union that no call site can satisfy.
   */
  save: (input: Record<string, unknown>) => Promise<unknown>;
  onDone: () => void;
}) {
  const connections = useGitConnections(spec.kind);
  const options = connectionOptions(spec.kind, connections.data);

  /**
   * The two choices the *queries* depend on are held here as well as in the
   * form, and this is deliberately one-directional: state is what the requests
   * read, `form.setValue` mirrors it for validation and submission. Reading them
   * back out of the form instead would put `useRepositories` after `useApiForm`
   * and `onSubmit` before the query it needs — which works, and reads like a bug.
   */
  const [connection, setConnection] = useState(() =>
    fieldText(row, spec.connectionKey),
  );
  const [chosen, setChosen] = useState<SourceRepository | null>(null);

  const repositories = useRepositories(spec.kind, connection);

  // The chosen repository, whether it came from this session's click or from the
  // row we loaded — the branch request needs the whole object, not just the key.
  const repository =
    chosen ??
    repositories.data?.find(
      (option) => option.key === repositoryKeyOf(row, spec),
    ) ??
    null;

  const branches = useBranches(spec.kind, connection, repository);

  const form = useApiForm<GitSourceValues>({
    schema: gitSourceSchema,
    defaultValues: {
      connection: fieldText(row, spec.connectionKey),
      repository: repositoryKeyOf(row, spec),
      branch: fieldText(row, spec.branchKey),
      buildPath: fieldText(row, path.column(spec)) || path.fallback,
      triggerType: row.triggerType ?? "push",
      autoDeploy: row.autoDeploy ?? true,
    },
    onSubmit: async (values) => {
      const picked = repositories.data?.find(
        (option) => option.key === values.repository,
      );
      await save(sourceInput(spec, path, values, picked));
      toast.done("Source saved.", {
        description: "The next Deployment builds from it.",
      });
      onDone();
    },
    onError: (error) => toast.error(error),
  });

  if (connections.isPending) {
    return (
      <div className="grid gap-2.5" aria-busy="true">
        <Skeleton className="h-ctl" />
        <Skeleton className="h-ctl" />
      </div>
    );
  }

  // A **refusal is not an empty list**, and conflating them was a real defect
  // here: a 403 on `GET /gitea` left `data` undefined, which read as zero
  // options, which rendered "No Gitea account is connected" — a confident claim
  // about the Organization's setup, made because a request failed. The two now
  // say different things, and only one of them blames the operator.
  if (connections.error) {
    return (
      <p className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
        {errorMessage(connections.error)}
      </p>
    );
  }

  if (options.length === 0) return <NoConnection spec={spec} />;

  return (
    <FormProvider {...form}>
      <form method="post" noValidate onSubmit={form.submit} className="grid gap-3.5">
        <GitSourceChain
          spec={spec}
          options={options}
          connection={connection}
          repositories={repositories}
          repository={repository}
          branches={branches}
          onConnection={(next) => {
            setConnection(next);
            setChosen(null);
          }}
          onRepository={setChosen}
          locked={locked}
        />

        <GitSourceBuildFields
          path={path}
          locked={locked}
          pushDeploys={pushCanDeploy(row, spec.kind)}
        />

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
