import { Card } from "@/components/console/card";

export type AuthPanelProps = {
  title: React.ReactNode;
  /** One sentence saying what this screen wants, before they look at the fields. */
  lede?: React.ReactNode;
  children: React.ReactNode;
  /** The way out of this screen — the other door, in a quieter voice. */
  footer?: React.ReactNode;
};

/**
 * The one shape every auth screen takes: a title, a sentence, a card, a way out.
 *
 * The title sits **outside** the card rather than in `Card.Header`, which is the
 * console's own idiom — a `PageHeader` above the surface the work happens on.
 * That leaves the card holding nothing but the form, so its edges bound the thing
 * you interact with instead of the whole screen.
 *
 * **`text-sect`, not `text-disp`.** The page-title step is calibrated against a
 * 1360px measure; at 400px a 30px title outweighs the six fields under it, which
 * is why `PageHeader` itself steps down to `text-sect` below 620px. This column is
 * narrower than that breakpoint at every viewport, so it takes the narrow-column
 * step everywhere and stops changing size for no reason.
 */
export function AuthPanel({ title, lede, children, footer }: AuthPanelProps) {
  return (
    <>
      <header className="mb-4">
        <h1 className="text-sect wrap-anywhere text-tx">{title}</h1>
        {lede ? <p className="mt-1.5 text-body text-tx-2">{lede}</p> : null}
      </header>

      <Card>
        <Card.Body className="p-5">{children}</Card.Body>
      </Card>

      {footer ? (
        <div className="mt-4 flex flex-wrap justify-center gap-x-4 gap-y-1.5 text-center text-meta text-tx-2">
          {footer}
        </div>
      ) : null}
    </>
  );
}
