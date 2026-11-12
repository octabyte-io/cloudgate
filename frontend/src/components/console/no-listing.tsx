import { Icon, type IconName } from "@/lib/design/icons";

/**
 * A screen, or a section of one, whose data cannot be listed here — because of
 * what this instance is, not because the list is empty.
 *
 * **Built by F08 and promoted here by F10**, which is the second phase to need it
 * and therefore the one that makes it shared. It has been retired from a caller
 * at a time as the routes behind them arrived, and what that has left is a
 * narrower component than the one F08 wrote. Every surviving caller says something
 * true about the *world*, and none of them says "no endpoint exists":
 *
 * - **A Redis has no backups** (`database/panels/backups.tsx`) — the five other
 *   engines have a dump and restore command and it has neither, so `POST /backups`
 *   does not accept one. A limit of the engine, stated where the list would be.
 * - **This host has no Traefik configuration** (`requests/logging-card.tsx`) and
 *   **this host is not a Swarm manager** (`server/panels/overview.tsx`) — the read
 *   exists and the machine cannot answer it.
 * - **This Server is not being monitored yet** (`server/panels/telemetry.tsx`) —
 *   samples exist once an interval does, and the footer goes where to set one up.
 *
 * **The two callers that made this component ambiguous are gone.** An
 * Environment's Deployments and Domains tabs used it for *"this would cost more
 * than it is worth"* — both feeds were keyed by a service id, so gathering them
 * meant one request per service on every open. `GET /environments/:id/deployments`
 * and `/domains`
 * answer each in one request, and both tabs are ordinary tables with ordinary
 * empty states. So this is once again used only for *"the platform cannot"*, which
 * is the meaning worth keeping: a component that covers both is a component that
 * cannot be read off a screen. (The three sections of an Application's Advanced
 * tab went the same way once they had list routes.)
 *
 * It is deliberately **not** an `EmptyState`: that one says "nothing here yet" and
 * carries the control that makes the first one, and saying "no backups" about a
 * Redis that can never have one would be an invitation to do something impossible.
 * It is not an `Outcome` either — nothing failed, the address is right, and the
 * rest of the scope works. It is a statement about the product, made where the
 * missing thing would be, in the tone of the tinted marks the rest of the console
 * uses for "worth knowing, nothing is broken".
 */
export function NoListing({
  icon,
  title,
  children,
  /** What *does* work, so the screen is not a dead end. */
  footer,
}: {
  icon: IconName;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <div className="grid place-items-center gap-2.25 px-5 py-14 text-center">
      <span className="mb-1 grid size-11 place-items-center rounded-pill border border-info-line bg-info-tint text-info">
        <Icon name={icon} size={20} />
      </span>
      <h3 className="text-sect text-tx">{title}</h3>
      <p className="max-w-copy text-body text-tx-2">{children}</p>
      {footer ? (
        <p className="mt-0.5 max-w-copy text-meta text-tx-2">{footer}</p>
      ) : null}
    </div>
  );
}
