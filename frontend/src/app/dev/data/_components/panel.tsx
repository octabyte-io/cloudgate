/**
 * The harness's own shell, local to /dev/data. Deliberately not a component
 * anyone else can import: F03 owns the real Card, and a dev page must not be
 * where components are born.
 */
export function Panel({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-line bg-panel">
      <header className="border-b border-line px-4 py-3.5 sm:px-5">
        <h2 className="text-sect text-tx">{title}</h2>
        {blurb ? (
          <p className="mt-1.5 max-w-prose text-body text-tx-2">{blurb}</p>
        ) : null}
      </header>
      <div className="flex flex-col gap-3 p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** A key and its value, on one row, value truncating rather than wrapping. */
export function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="text-ui font-medium text-tx-3">{label}</span>
      <span className="num min-w-0 font-mono text-meta break-all text-tx-2">
        {children}
      </span>
    </div>
  );
}

/** Raw JSON, scrolling inside its own box so the page never scrolls sideways. */
export function Dump({ value }: { value: unknown }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg bg-panel-2 p-3 font-mono text-meta text-tx-2">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** What went wrong, in the voice the real interface will use. */
export function Failure({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2 text-body text-tx">
      {message}
    </p>
  );
}
