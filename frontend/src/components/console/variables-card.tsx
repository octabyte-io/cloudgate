import { useState } from "react";

import { Card } from "@/components/console/card";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Button } from "@/components/ui/button";
import type { NameLock } from "@/components/console/config-lock";
import type { Gate } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { parseEnvBlob, type EnvVariable } from "@/lib/format/env-blob";
import type { ReferenceSources } from "@/lib/format/env-lint";
import { VariablesForm } from "@/components/console/variables-form";

const MASK = "••••••••";

/**
 * A Project's or an Environment's variables: what is set, and the block that
 * sets it.
 *
 * Reading and editing are two different screens of the same card, on purpose.
 * The endpoint only takes the whole blob, so editing has to be a textarea — but
 * a textarea is a poor way to *read* forty variables, and it cannot hide a
 * password while you scan the key beside it. So the resting state is a table
 * with the values masked, and "Edit" swaps in the block.
 *
 * **The mask is a guess made from the key's name** (`env-blob.ts`), and the strip
 * above the table says so. There is no per-variable secret flag in the schema to
 * do better with, and a rule that quietly showed a `DATABASE_URL` because it was
 * not called `PASSWORD` would be worse than one that is occasionally cautious.
 *
 * **Edit is off, with the reason, for a role that cannot save**
 * It used to open
 * the textarea, take the typing and meet the 403 on Save. Which statement the
 * save needs is the caller's to know — `service`, `environment` or `project`
 * `['update']` — so the card is handed the verdict as `gate`, and a card that
 * is only ever read (`canEdit={false}`) takes none. One of the two is required,
 * so a new caller cannot leave the question unanswered.
 */
export function VariablesCard({
  env,
  save,
  noun,
  title = "Variables",
  sub,
  meta,
  emptyBody,
  canEdit = true,
  gate,
  names = null,
  references,
}: {
  env: string;
  save: (next: string) => Promise<unknown>;
  /** What this blob belongs to — "Project", "Environment". Used in the toast. */
  noun: string;
  title?: string;
  sub?: string;
  /** The sentence above the table. Say who can reach these, and how. */
  meta?: React.ReactNode;
  /**
   * The empty state's sentence.
   *
   * **Parameterised by F11**, which was the first caller for whom the default was
   * false: "handed to everything deployed below them" is nonsense for a *service*
   * — nothing is deployed below a database.
   *
   * **F19 fixed the default too**, because F11's note already contained the
   * reason and stopped one step short: the platform does not inherit these
   * downward *for anybody*. `prepareEnvironmentVariables` resolves `${{…}}`
   * references and never merges levels
   * so the old
   * default was not merely wrong for services — it was wrong on a Project and an
   * Environment as well, which is where it was doing the damage, since those are
   * the two screens where somebody decides to set a key once and stop.
   */
  emptyBody?: React.ReactNode;
  /**
   * The names this blob may hold when a repository-kept Project config lists
   * them (`variableNameLock`): values stay editable here, a new name is
   * the file's to add.
   */
  names?: NameLock | null;
  /** What a Service's `${{…}}` references can name; see `VariablesForm`. */
  references?: ReferenceSources;
} & (
  | {
      /** Read-only: somebody else's blob, shown for reference. */
      canEdit: false;
      gate?: never;
    }
  | {
      canEdit?: true;
      /** Whether this caller may save it, and why not — see the note above. */
      gate: Gate;
    }
)) {
  const allowed = gate?.allowed ?? false;
  const refusal = gate && !gate.allowed ? gate.refusal : undefined;
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const variables = parseEnvBlob(env);
  const hidden = variables.filter((v) => v.secret).length;

  return (
    <Card>
      <Card.Header
        title={title}
        sub={sub}
        headingLevel={2}
        actions={
          editing ? null : (
            <>
              {hidden > 0 ? (
                <Button
                  size="xs"
                  onClick={() => setRevealed((on) => !on)}
                  aria-pressed={revealed}
                >
                  <Icon name={revealed ? "eyeOff" : "eye"} size={14} />
                  {revealed ? "Hide values" : "Show values"}
                </Button>
              ) : null}
              {/* With nothing set, the empty state's "Add variables" is the one
                  way in — two primaries for one action is one too many. */}
              {canEdit && variables.length > 0 ? (
                <Button
                  size="xs"
                  variant="pri"
                  disabled={!allowed}
                  title={refusal}
                  onClick={() => allowed && setEditing(true)}
                >
                  <Icon name="pencil" size={14} />
                  Edit
                </Button>
              ) : null}
            </>
          )
        }
      />

      {editing ? (
        <Card.Body>
          <VariablesForm
            env={env}
            save={save}
            noun={noun}
            names={names}
            references={references}
            onDone={() => setEditing(false)}
          />
        </Card.Body>
      ) : (
        <>
          {meta ? <MetaStrip>{meta}</MetaStrip> : null}
          <Card.Body flush>
            <DataTable
              label={`${noun} variables`}
              rows={variables}
              getRowId={(row) => `${row.line}-${row.key}`}
              defaultSort={{ id: "key", dir: "asc" }}
              columns={[
                {
                  id: "key",
                  head: "Key",
                  tone: "key",
                  className: "font-mono",
                  compare: (a, b) => a.key.localeCompare(b.key),
                  cell: (row) => row.key,
                },
                {
                  id: "value",
                  head: "Value",
                  tone: "wrap",
                  className: "font-mono wrap-anywhere",
                  cell: (row) => <Value row={row} revealed={revealed} />,
                },
              ]}
              empty={
                <EmptyState
                  icon="hash"
                  title="No variables here yet"
                  action={
                    canEdit ? (
                      <Button
                        size="sm"
                        variant="pri"
                        disabled={!allowed}
                        title={refusal}
                        onClick={() => allowed && setEditing(true)}
                      >
                        Add variables
                      </Button>
                    ) : undefined
                  }
                >
                  {emptyBody ?? (
                    <>
                      Add them as a block of <code>KEY=value</code> lines.
                    </>
                  )}
                </EmptyState>
              }
            />
          </Card.Body>
        </>
      )}
    </Card>
  );
}

/**
 * A value, or the fact that there is one and it is hidden.
 *
 * A quoted value may span lines, and the deploy hands the container every one
 * of them, so the line breaks are kept (`whitespace-pre-wrap`) rather
 * than collapsed into one line that reads as a single-line value.
 *
 * The mask carries its own word rather than only dots: `sr-only` says "hidden",
 * so a screen reader is told the value exists and is not being read out, instead
 * of hearing eight bullet characters or nothing at all.
 */
function Value({ row, revealed }: { row: EnvVariable; revealed: boolean }) {
  if (!row.secret || revealed) {
    return row.value === "" ? (
      <span className="text-tx-3">empty</span>
    ) : (
      <span className="whitespace-pre-wrap">{row.value}</span>
    );
  }
  return (
    <>
      <span aria-hidden="true" className="text-tx-3 tracking-widest">
        {MASK}
      </span>
      <span className="sr-only">Hidden. Choose Show values to read it.</span>
    </>
  );
}
