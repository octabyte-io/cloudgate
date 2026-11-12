import type { Server } from "@/lib/api/endpoints/servers";

/**
 * A **Bought Server** an Operator powered off for abuse (ADR-0071, #1401):
 * every tab says so, with the reason the Operator gave, and that only
 * Cloudgate can power it back on — nothing on the page can. Nothing for any
 * other Server.
 */
export function PoweredOffNotice({ server }: { server: Server }) {
  const poweredOff = server.boughtServer?.poweredOff;
  if (!poweredOff) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx"
    >
      <p className="font-medium wrap-anywhere">
        Powered off by Cloudgate: {poweredOff.reason}
      </p>
      <p className="mt-1 text-meta text-tx-2">
        Only Cloudgate can power it back on. Reply to the email about it, or
        contact Octabyte.
      </p>
    </div>
  );
}
