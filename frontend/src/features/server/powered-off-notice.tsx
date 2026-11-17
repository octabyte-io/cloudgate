import type { Server } from "@/lib/api/endpoints/servers";
import { OCTABYTE_CONTACT } from "@/lib/contact";
import { Icon } from "@/lib/design/icons";

/**
 * A **Bought Server** an Operator powered off for abuse (ADR-0071, #1401):
 * every tab says so, with the reason the Operator gave, and that only an
 * Operator can power it back on — nothing on the page can — naming where to
 * ask. Nothing for any other Server.
 *
 * Drawn as the deletion notice beside it is (`bought-server-notice.tsx`):
 * the same danger bar, icon and bottom margin, so the two stack evenly above
 * the page's cards.
 */
export function PoweredOffNotice({ server }: { server: Server }) {
  const poweredOff = server.boughtServer?.poweredOff;
  if (!poweredOff) return null;
  return (
    <div
      role="status"
      data-slot="powered-off-notice"
      className="mb-4 flex gap-2.5 rounded-lg border border-bad-line bg-bad-tint px-4 py-3"
    >
      <Icon name="alert" size={15} className="mt-0.5 flex-none text-bad" />
      <div className="grid min-w-0 gap-1">
        <p className="text-ui font-semibold text-tx">
          <span className="sr-only">Danger: </span>
          Powered off by an operator
        </p>
        <p className="text-ui text-tx wrap-anywhere">
          Reason: {poweredOff.reason}
        </p>
        <p className="text-meta text-tx-2">
          Only an operator can power it back on. Reply to the email about it,
          or write to{" "}
          <a
            href={`mailto:${OCTABYTE_CONTACT}`}
            className="text-brand-tx underline underline-offset-2"
          >
            {OCTABYTE_CONTACT}
          </a>
          .
        </p>
      </div>
    </div>
  );
}
