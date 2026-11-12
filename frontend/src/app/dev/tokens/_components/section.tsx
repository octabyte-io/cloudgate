/**
 * The gallery's own section shell. Local to /dev/tokens on purpose — F03 owns
 * the real Card, and this page must not become the place components are born.
 *
 * Labels are sentence case and muted. The prototype is emphatic about this
 * (e-console.html:340-342): the reference does not shout its group labels, and
 * uppercasing them is the fastest way to look like a different product.
 */
export function Section({
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
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

/** A muted line that names what the reader is about to look at. */
export function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-ui font-medium text-tx-3">{children}</p>;
}

/** A token name, a measured value, a hex triple: always mono, always tabular. */
export function Mono({
  children,
  wrap,
  className,
}: {
  children: React.ReactNode;
  /**
   * Set on a mono *phrase* — a shell command, a list of column names. Off by
   * default, because "--pan / el" is not a token name, and a section that clips
   * its own overflow will hide the evidence.
   */
  wrap?: boolean;
  className?: string;
}) {
  return (
    <span
      className={`num font-mono text-meta text-tx-2 ${
        wrap ? "break-words" : "whitespace-nowrap"
      } ${className ?? ""}`}
    >
      {children}
    </span>
  );
}
