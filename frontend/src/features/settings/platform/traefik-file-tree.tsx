import type { TreeDataItem } from "@/lib/api/endpoints/traefik";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * The walk, as a nested list.
 *
 * A real `<ul>` rather than a tree widget: `role="tree"` promises arrow-key
 * navigation and typeahead, and this is a handful of files two levels deep. The
 * same reasoning `Toolbar` uses for refusing `role="toolbar"`.
 *
 * **A withheld file is listed, not offered**. A certificate's
 * `privkey.key` and `acme.json` hold private keys, which the backend refuses to
 * send or overwrite and marks in the walk with its reason. So the row is text
 * rather than a button: omitting it would hide that the file exists, and a
 * button would only lead to a refusal. The row says "not shown" and the card's
 * footer says why once, rather than the backend's sentence under every key in
 * a 16rem column; the sentence itself is the row's title and its screen-reader
 * text.
 */
export function FileTree({
  nodes,
  selected,
  onSelect,
  depth = 0,
}: {
  nodes: TreeDataItem[];
  selected: string | null;
  onSelect: (path: string) => void;
  depth?: number;
}) {
  return (
    <ul className={cn(depth > 0 && "ml-3.5 border-l border-line pl-1.5")}>
      {nodes.map((node) =>
        node.type === "directory" ? (
          <li key={node.id}>
            <p className="flex items-center gap-1.5 px-2 py-1 text-meta font-medium text-tx-3">
              <Icon name="folder" size={13} />
              {node.name}
            </p>
            <FileTree
              nodes={node.children ?? []}
              selected={selected}
              onSelect={onSelect}
              depth={depth + 1}
            />
          </li>
        ) : node.withheld ? (
          <li key={node.id}>
            <p
              title={node.withheld}
              className="flex items-center gap-1.5 px-2 py-1 text-ui text-tx-3"
            >
              <Icon name="lock" size={13} />
              <span className="min-w-0 truncate">{node.name}</span>
              <span className="ml-auto shrink-0 text-meta">not shown</span>
              <span className="sr-only">: {node.withheld}</span>
            </p>
          </li>
        ) : (
          <li key={node.id}>
            <button
              type="button"
              aria-current={node.id === selected ? "true" : undefined}
              onClick={() => onSelect(node.id)}
              className={cn(
                "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-ui",
                node.id === selected
                  ? "bg-brand-tint font-medium text-brand-tx"
                  : "text-tx-2 hover:bg-raise hover:text-tx",
              )}
            >
              <span className="min-w-0 truncate">{node.name}</span>
            </button>
          </li>
        ),
      )}
    </ul>
  );
}

/**
 * Does this path look like a file Cloudgate writes for a service?
 *
 * `generateAppName` produces `<kind>-<six chars>`, so `dynamic/app-8pe8l2.yml`
 * and `dynamic/compose-7b7gzg.yml` are the shape. A name match rather than a
 * lookup, because the alternative is fetching every Application and Compose
 * stack in the Organization to compare `appName`s — and this is a warning, so a
 * false positive costs a sentence and a false negative costs somebody's edit.
 */
export function isGenerated(path: string): boolean {
  const name = path.split("/").pop() ?? "";
  return /^(application|app|compose|postgres|mysql|mariadb|mongo|redis|libsql)-[a-z0-9]{6}\.ya?ml$/.test(
    name,
  );
}
