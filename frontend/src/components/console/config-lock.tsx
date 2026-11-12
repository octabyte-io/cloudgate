"use client";

import type {
  EnvironmentConfigCopy,
  LockedService,
  VariableList,
} from "@/lib/api/endpoints/project-config";

import { useEnvironmentConfigCopy } from "@/lib/api/use-config-copy";

/**
 * Where a Service's config-owned fields are changed when its Project's config
 * is kept in a repository (US56): the file, the branch its Environment
 * reads, and the commit those fields were last applied from.
 *
 * The backend refuses a write the file would have to make
 * (`PROJECT_CONFIG_REPOSITORY_KEPT`, with the same pointer), so a lock here
 * only says ahead of time what a Save would be told. It is decided by the
 * same rule: the file describes the Service, or cannot be read. A Service
 * the file lists as `managed: console`, or does not list, is not locked.
 */
export interface ConfigLock {
  repository: string;
  path: string;
  /** The branch read; `null` only when the repository could not be reached. */
  branch: string | null;
  /** A link to the file at the commit read, when it could be read. */
  fileUrl: string | null;
  /** The commit the fields were last applied from, if a plan read one. */
  appliedCommit: string | null;
  /**
   * Of the fields set only when the file states them — `size` (the CPU and
   * memory limits), a postgres's `database` and `user` — those it states. One
   * it does not state stays editable.
   */
  stated: ReadonlySet<string>;
  /** The variable names the file lists: these may be given a value here. */
  listed: Readonly<Record<VariableList, readonly string[]>>;
}

export function configLockOf(
  copy: EnvironmentConfigCopy | undefined,
  serviceType: string,
  serviceId: string,
): ConfigLock | null {
  if (copy?.kind !== "repository") return null;
  const found: LockedService | undefined = (copy.services ?? []).find(
    (service) =>
      service.serviceType === serviceType && service.serviceId === serviceId,
  );
  if (!found?.owned) return null;
  return {
    repository: copy.repository,
    path: copy.path,
    branch: copy.copy?.branch ?? copy.refusal?.branch ?? copy.configBranch,
    fileUrl: copy.copy?.fileUrl ?? null,
    appliedCommit: found.appliedFrom?.commitSha ?? null,
    stated: new Set(found.stated ?? []),
    listed: {
      env: found.listed?.env ?? [],
      build_args: found.listed?.build_args ?? [],
      build_secrets: found.listed?.build_secrets ?? [],
    },
  };
}

/**
 * The lock on one Service, or `null` when its config-owned fields are the
 * console's to edit. Reads the Environment's copy, which every Service page
 * of that Environment shares.
 */
export function useConfigLock(
  environmentId: string,
  serviceType: string,
  serviceId: string,
): ConfigLock | null {
  const copy = useEnvironmentConfigCopy(environmentId);
  return configLockOf(copy.data, serviceType, serviceId);
}

const onBranch = (lock: ConfigLock) =>
  lock.branch === null ? "" : ` on branch ${lock.branch}`;

/** Whether the file sets `field` (one set only when stated) on a locked Service. */
export function statesField(lock: ConfigLock | null, field: string): boolean {
  return lock !== null && lock.stated.has(field);
}

/**
 * The names a variables editor on a locked Service may not add: anything but
 * a name it holds already or one the file lists. Values stay
 * editable, and removing a listed name is only a note on the next plan.
 */
export function variableNameLock(
  lock: ConfigLock | null,
  list: VariableList,
  held: readonly string[],
): NameLock | null {
  if (lock === null) return null;
  return {
    allowed: new Set([...held, ...lock.listed[list]]),
    refusal: `New variable names are set by the Project config. Add it to ${lock.path} in ${lock.repository}${onBranch(lock)}, then check for changes.`,
  };
}

/** Names an editor may not add, and the sentence it says when one is. */
export interface NameLock {
  allowed: ReadonlySet<string>;
  refusal: string;
}

/** What a locked control says when someone reaches for it. */
export function lockRefusal(lock: ConfigLock): string {
  return `Set by the Project config. Change it in ${lock.path} in ${lock.repository}${onBranch(lock)}, then check for changes.`;
}

/**
 * The line a locked card carries: what the file sets, where, and the commit
 * it was last applied from. `what` is the subject with its verb — "The build
 * settings are", "The CPU and memory limits are".
 */
export function ConfigLockNote({
  lock,
  what,
  rest,
}: {
  lock: ConfigLock;
  what: string;
  /** What on the card stays Cloudgate's, when some of it does. */
  rest?: string;
}) {
  return (
    <p className="text-meta text-tx-2" data-slot="config-lock">
      {what} set by the Project config: <code>{lock.path}</code> in{" "}
      <span className="font-mono">{lock.repository}</span>
      {onBranch(lock)}.{" "}
      {lock.appliedCommit === null ? (
        "They have not been applied from a commit yet."
      ) : (
        <>
          Last applied from commit{" "}
          <span className="font-mono">{lock.appliedCommit.slice(0, 7)}</span>.
        </>
      )}{" "}
      {rest ? `${rest} ` : null}
      {lock.fileUrl ? (
        <a
          href={lock.fileUrl}
          target="_blank"
          rel="noreferrer"
          className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
        >
          Open the file
        </a>
      ) : null}
    </p>
  );
}
