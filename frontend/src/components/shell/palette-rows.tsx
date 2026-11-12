import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import {
  PREFIXES,
  type PaletteKind,
  type PaletteResult,
} from "./palette-sources";

/**
 * What the command palette's list is made of.
 *
 * Split from `command-palette.tsx` because the two halves change for different
 * reasons: that file is the combobox's keyboard and focus behaviour — the part
 * that was wrong three times over — and this one is four rows of markup.
 */

/** What to type. The empty state is an instruction, not an apology. */
export function Tips() {
  return (
    <>
      <Label>Search tips</Label>
      {PREFIXES.map((prefix) => (
        <p
          key={prefix.prefix}
          className="flex h-9.5 items-center gap-2.5 rounded-md px-2.5 text-body text-tx"
        >
          <Icon name={prefix.icon} size={15} className="text-tx-3" />
          <span className="flex-none font-mono text-meta text-brand-tx">
            {prefix.prefix}:
          </span>
          <span className="min-w-0 flex-1 truncate">{prefix.description}</span>
        </p>
      ))}
    </>
  );
}

/**
 * What an empty list says, and the one thing it must never do is point
 * at a prefix that cannot help. It used to offer "Try a prefix — proj:, env: or
 * srv:" to everything: to a query that already had one, and to an
 * Application's name, which no prefix finds — Services are deliberately not
 * searched (`palette-sources.ts` says why).
 *
 * So a prefixed query names what was searched — and whether there is anything
 * of that kind at all, because "No Server matches" on an instance with no
 * Servers sends the operator off to try another spelling. But "none yet" only
 * when the list was actually read: a source that failed or was refused has
 * told us nothing, and "Add one" to someone who may not see the Servers that
 * exist is advice about the wrong problem. A bare query says what ⌘K covers,
 * and where a Service is found instead.
 */
export function noMatch(
  all: PaletteResult[],
  unavailable: PaletteKind[],
  kind: PaletteKind | null,
  query: string,
): string {
  const missing = new Intl.ListFormat("en", { type: "conjunction" }).format(
    PREFIXES.filter((prefix) => unavailable.includes(prefix.prefix)).map(
      (prefix) => prefix.plural,
    ),
  );

  // `kind` is only ever one of PREFIXES' own, so this finds it whenever it is set.
  const each = PREFIXES.find((prefix) => prefix.prefix === kind);
  if (!each) {
    const searched = `Nothing matches “${query}”. ⌘K searches Projects, Environments, Servers and pages — a Service is found inside its Environment.`;
    return missing ? `${searched} ${missing} could not be loaded.` : searched;
  }

  if (unavailable.includes(each.prefix)) {
    return `${each.plural} could not be loaded, so ⌘K cannot search them right now.`;
  }
  if (!all.some((row) => row.kind === each.prefix)) return each.noneYet;
  // As typed, not as `filterPalette` folded it for matching.
  const term = query.slice(query.indexOf(":") + 1).trim();
  return `No ${each.noun} matches “${term}”.`;
}

/**
 * What a row says it is, when the query has no prefix to say it for every row:
 * the plain noun ("Server"), where it used to print the prefix itself — a raw
 * mono "srv:" in brand colour that read as syntax, not as a word. The
 * prefix still belongs to the Tips, which teach what to type.
 */
export function kindWord(kind: PaletteKind): string {
  const noun = PREFIXES.find((prefix) => prefix.prefix === kind)?.noun ?? kind;
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

export function Row({
  id,
  index,
  result,
  current,
  showKind,
  onChoose,
}: {
  id: string;
  index: number;
  result: PaletteResult;
  current: boolean;
  showKind: boolean;
  onChoose: () => void;
}) {
  const word = showKind ? kindWord(result.kind) : null;
  // An Environment's hint is the word "Environment", a page's is "page": beside
  // the kind they would say it twice.
  const hint =
    word && result.hint.toLowerCase() === word.toLowerCase() ? null : result.hint;
  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={current}
      data-index={index}
      // The input keeps focus for the whole interaction, so this is never
      // tabbed to — arrow keys move the highlight instead.
      tabIndex={-1}
      onClick={onChoose}
      className={cn(
        "flex h-9.5 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body text-tx hover:bg-raise",
        current && "bg-raise",
      )}
    >
      <Icon name={result.icon} size={15} className="flex-none text-tx-3" />
      {word ? (
        <span className="flex-none text-meta text-tx-3">{word}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{result.name}</span>
      {hint ? (
        <span className="flex-none truncate text-meta text-tx-3 max-hd:hidden">
          {hint}
        </span>
      ) : null}
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-2.25 pb-1.25 text-meta font-medium text-tx-3">
      {children}
    </div>
  );
}

export function Kbd({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <kbd
      className={cn(
        "rounded-sm border border-line bg-panel px-1 py-0.5 text-chip font-medium text-tx-2",
        className,
      )}
    >
      {children}
    </kbd>
  );
}
