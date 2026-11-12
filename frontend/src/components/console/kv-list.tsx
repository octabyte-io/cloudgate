import { cn } from "@/lib/utils";

/**
 * The facts about one thing, one per line (e-console.html:694-706): image
 * digest, created, region, port, exposed on.
 *
 * A `<dl>` rather than the reference's stack of divs — this *is* a description
 * list, and the pairing is worth having in the accessibility tree rather than
 * implied by which side of the row a string sits on. The rows are `<div>`s
 * inside it, which HTML allows, so the flex layout still works.
 */
export function KVList({ className, ...props }: React.ComponentProps<"dl">) {
  return (
    <dl
      data-slot="kv-list"
      className={cn("flex flex-col", className)}
      {...props}
    />
  );
}

export type KVRowProps = Omit<React.ComponentProps<"div">, "children"> & {
  label: string;
  value: React.ReactNode;
  /** A literal — a digest, a port, an address. Sets it in mono, one step down. */
  mono?: boolean;
  /**
   * The full value, for when the visible one is truncated. Set it whenever the
   * value can be long: the row shows the end of a digest as "…", and a tooltip
   * is the only way back to the rest of it without leaving the page.
   */
  title?: string;
  /** A trailing control — copy, edit. Never the value itself. */
  action?: React.ReactNode;
};

/**
 * One fact. The value is right-aligned and truncates, so a column of them has a
 * hard right edge and a long one cannot push the row sideways — which is what
 * would otherwise happen in a 336px rail holding a `sha256:` digest.
 */
export function KVRow({
  className,
  label,
  value,
  mono,
  title,
  action,
  ...props
}: KVRowProps) {
  return (
    <div
      data-slot="kv-row"
      className={cn(
        "flex items-center gap-2.5 border-b border-line py-2.5 text-ui last:border-b-0",
        className,
      )}
      {...props}
    >
      <dt className="flex-none text-tx-2">{label}</dt>
      <dd
        title={title}
        className={cn(
          "min-w-0 flex-1 truncate text-right text-tx",
          mono && "font-mono text-meta tracking-mono",
        )}
      >
        {value}
      </dd>
      {action ? <div className="flex-none text-tx-3">{action}</div> : null}
    </div>
  );
}
