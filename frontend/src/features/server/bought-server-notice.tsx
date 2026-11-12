import Link from "next/link";

import { formatDay } from "@/lib/api/endpoints/billing";
import type { Server } from "@/lib/api/endpoints/servers";
import { Icon } from "@/lib/design/icons";

/**
 * The red bar above every tab of a **Bought Server** that is going, or has
 * gone (ADR-0071, #1397):
 *
 * - **Due for deletion on <date>**: a payment for it failed. It keeps
 *   working until then; paying the open invoice keeps it.
 * - **Deleted**: its machine was deleted on <date> and its data is gone.
 *   The record stays, with its Services still listed, until it is deleted
 *   here, which calls nothing outside Cloudgate.
 *
 * Nothing for any other Server.
 */
export function BoughtServerNotice({
  server,
}: {
  server: Pick<Server, "boughtServer">;
}) {
  const bought = server.boughtServer;
  if (!bought) return null;

  if (bought.stage === "deleted" && bought.deletedAt) {
    return (
      <Bar>
        <strong className="font-semibold">Deleted.</strong> Its machine was
        deleted on {formatDay(bought.deletedAt)}, and its data and backups are
        gone. Its Services are still listed: move or delete them, then delete
        this Server.
      </Bar>
    );
  }

  if (bought.deletesOn) {
    return (
      <Bar>
        <strong className="font-semibold">
          Due for deletion on {formatDay(bought.deletesOn)}.
        </strong>{" "}
        A payment for it failed. It keeps working until then, and is deleted
        with its data and backups unless the open invoice is paid.{" "}
        <Link
          href="/settings/billing"
          className="text-brand-tx underline underline-offset-2"
        >
          Pay the open invoice
        </Link>
      </Bar>
    );
  }

  return null;
}

function Bar({ children }: { children: React.ReactNode }) {
  return (
    <div
      role="status"
      data-slot="bought-server-notice"
      className="mb-4 flex gap-2.5 rounded-lg border border-bad-line bg-bad-tint px-4 py-2.75"
    >
      <Icon name="alert" size={15} className="mt-0.5 flex-none text-bad" />
      <p className="min-w-0 text-ui text-tx">
        <span className="sr-only">Danger: </span>
        {children}
      </p>
    </div>
  );
}
