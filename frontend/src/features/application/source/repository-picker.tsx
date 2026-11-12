import { useMemo, useState } from "react";

import { MenuRow } from "@/components/console/menu";
import { SearchInput } from "@/components/console/search-input";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { SourceRepository } from "@/lib/api/endpoints/git-providers";
import { Icon } from "@/lib/design/icons";

/**
 * Which repository to build.
 *
 * **A filterable list, not a `Picker`.** Every other choice on this screen is a
 * popup, and this one cannot be: a git connection reaches every repository its
 * token can see, which is tens for a person and hundreds for an organization, and
 * a popup you can only typeahead through is a popup nobody finds `web-store` in.
 * So it is a search field over a scrolling list of rows — the same `MenuRow` a
 * menu is made of, which is exactly what that component was factored out for.
 *
 * Once something is chosen it **collapses to one row and a Change button**, so a
 * form with three more fields under it is not permanently half list. That is also
 * what makes the resting state readable: the answer, not the question.
 *
 * The empty and refused states are distinct on purpose. No repositories at all
 * means the connection cannot see any — a GitHub App installed on no
 * repositories is the common cause, and the operator has to go and grant it. A
 * refusal means the provider said no, and the sentence it said is worth showing.
 */
export function RepositoryPicker({
  repositories,
  pending,
  error,
  waiting,
  chosen,
  onChoose,
  onRefresh,
  noun,
  plural,
  id,
  "aria-describedby": describedBy,
  "aria-invalid": invalid,
  locked,
}: {
  repositories: SourceRepository[] | undefined;
  pending: boolean;
  error: unknown;
  /**
   * Nothing has been asked for yet, because no connection is chosen.
   *
   * Distinct from an empty answer, and the distinction was a real defect: with no
   * connection the query is disabled, so `data` is undefined — which read as "this
   * connection cannot see any repositories" about a connection nobody had picked.
   */
  waiting?: boolean;
  /** The one currently selected, or `null` while nothing is. */
  chosen: SourceRepository | null;
  onChoose: (repository: SourceRepository) => void;
  onRefresh: () => void;
  /** What this provider calls one — "repository", "project". */
  noun: string;
  /** And its plural, spelled out rather than derived (see `providers.ts`). */
  plural: string;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
  /**
   * Set elsewhere: the saved repository is shown and cannot be
   * changed, with `reason` on its hover. `current` is the saved key, shown
   * when this connection's list does not name it.
   */
  locked?: { reason: string; current: string };
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = repositories ?? [];
    if (needle === "") return all;
    return all.filter((repository) =>
      `${repository.owner}/${repository.name}`.toLowerCase().includes(needle),
    );
  }, [repositories, query]);

  // Chosen and not being changed: the answer, and the way back to the question.
  if (locked || (chosen && !open)) {
    return (
      <div
        id={id}
        aria-describedby={describedBy}
        className="flex items-center gap-2.5 rounded-lg border border-line bg-panel-2 px-3 py-2"
      >
        <Icon name="branch" size={15} className="flex-none text-tx-3" />
        <span className="min-w-0 flex-1 truncate font-mono text-meta tracking-mono text-tx">
          {chosen ? `${chosen.owner}/${chosen.name}` : locked?.current}
        </span>
        <Button
          size="xs"
          type="button"
          disabled={locked !== undefined}
          title={locked?.reason}
          onClick={() => setOpen(true)}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div
      id={id}
      aria-describedby={describedBy}
      aria-invalid={invalid}
      className="rounded-lg border border-line bg-panel"
    >
      <div className="flex items-center gap-2 border-b border-line p-2">
        <SearchInput
          label={`Search ${plural}`}
          placeholder={`Search ${plural}`}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button
          size="icon-sm"
          type="button"
          onClick={onRefresh}
          aria-label={`Refresh the ${noun} list`}
          title={`Refresh the ${noun} list`}
        >
          <Icon name="refresh" size={14} />
        </Button>
      </div>

      <div className="max-h-64 overflow-y-auto overscroll-contain p-1.5">
        {waiting ? (
          <p className="px-2.25 py-3 text-meta text-tx-2">
            Choose a connection above and its {plural} appear here.
          </p>
        ) : pending ? (
          <div className="grid gap-1.5" aria-busy="true">
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
            <Skeleton className="h-8" />
          </div>
        ) : error ? (
          <p className="px-2.25 py-3 text-meta text-bad">
            {errorMessage(error)}
          </p>
        ) : matches.length === 0 ? (
          <p className="px-2.25 py-3 text-meta text-tx-2">
            {(repositories ?? []).length === 0
              ? `This connection cannot see any ${plural}. Grant it access to one and refresh.`
              : `No ${noun} matches “${query.trim()}”.`}
          </p>
        ) : (
          matches.map((repository) => {
            const selected = repository.key === chosen?.key;
            return (
              <MenuRow
                key={repository.key}
                aria-pressed={selected}
                onClick={() => {
                  onChoose(repository);
                  setOpen(false);
                }}
                className={selected ? "font-medium text-brand-tx" : undefined}
              >
                <span className="font-mono text-meta tracking-mono">
                  {repository.owner}/{repository.name}
                </span>
              </MenuRow>
            );
          })
        )}
      </div>

      {chosen ? (
        <div className="flex items-center justify-end border-t border-line px-2 py-1.5">
          <Button size="xs" type="button" onClick={() => setOpen(false)}>
            Keep {chosen.name}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
