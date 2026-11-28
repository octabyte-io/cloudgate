"use client";

import { notFound } from "next/navigation";
import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { LinkButton } from "@/components/console/link-button";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { BoughtServerRow } from "@/lib/api/endpoints/bought-servers";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { perMonth } from "../bought-server/per-month";
import {
  useBoughtServerOffer,
  useBoughtServers,
  useFinishPaying,
} from "../buy/use-bought-servers";
import { SERVER_CREATE_REFUSAL } from "../use-server";
import { boughtServerColumns, isCharged } from "./bought-server-columns";

/**
 * The **Bought Servers** page (#199, spec #196), behind the Organization
 * rail's row: every Bought Server with its stage, size, Location, backups
 * and monthly price, laid out as the prototype's variant B. Manage opens a
 * Server's Bought Server tab; one waiting for payment offers *Finish
 * paying*, as the Servers page's "Servers being bought" does. Hosted only,
 * and only while buying is offered, the rail row's own condition: anywhere
 * else the page is not found.
 */
export function BoughtServersScreen() {
  const offer = useBoughtServerOffer();
  const list = useBoughtServers(offer.offered);
  const canCreate = usePermission({ server: ["create"] });
  const finish = useFinishPaying();
  const [said, setSaid] = useState<string | null>(null);

  if (!offer.pending && !offer.offered) notFound();

  function finishPaying(row: BoughtServerRow) {
    setSaid(null);
    finish.mutate(row.id, {
      onSuccess: (result) => {
        if (result.payUrl) window.location.assign(result.payUrl);
      },
      onError: (error) => setSaid(errorMessage(error)),
    });
  }

  const buy = canCreate.allowed ? (
    <LinkButton href="/servers/buy" variant="pri">
      <Icon name="plus" size={15} />
      Buy a Server
    </LinkButton>
  ) : (
    <Button variant="pri" disabled title={SERVER_CREATE_REFUSAL}>
      <Icon name="plus" size={15} />
      Buy a Server
    </Button>
  );

  const rows = list.data ?? [];
  const columns = boughtServerColumns({
    onFinishPaying: finishPaying,
    paying: finish.isPending,
  });

  return (
    <Page>
      <PageHeader
        title="Bought Servers"
        icon="cash"
        lede="The Servers you bought from Cloudgate: their backups, size and what they cost."
        actions={buy}
      />
      <Cols>
        {said ? (
          <p role="status" className="text-body text-tx-2">
            {said}
          </p>
        ) : null}
        <Card>
          {list.error ? (
            <Card.Body>
              <p className="text-body text-tx-2">{errorMessage(list.error)}</p>
            </Card.Body>
          ) : list.isPending ? (
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          ) : (
            <>
              {rows.length > 0 ? <Summary rows={rows} /> : null}
              <Card.Body flush>
                <DataTable
                  label="Bought Servers"
                  columns={columns}
                  rows={rows}
                  getRowId={(row) => row.id}
                  empty={
                    <EmptyState
                      icon="cash"
                      title="No Bought Servers yet"
                      action={
                        canCreate.allowed ? (
                          <LinkButton
                            href="/servers/buy"
                            size="sm"
                            variant="pri"
                          >
                            Buy a Server
                          </LinkButton>
                        ) : null
                      }
                    >
                      Buy a Server to have one set up for you, paid monthly on
                      your plan&apos;s invoice.
                    </EmptyState>
                  }
                />
              </Card.Body>
            </>
          )}
        </Card>
      </Cols>
    </Page>
  );
}

/**
 * How many there are and what they cost a month on the plan's invoice. One
 * still waiting for payment is not on it yet, so it is counted apart and
 * left out of the total; one Deleting is off it already, since deletion
 * takes it off the subscription first, so it is left out of both.
 */
function Summary({ rows }: { rows: BoughtServerRow[] }) {
  const waiting = rows.filter((row) => row.stage === "waiting_for_payment");
  const paid = rows.filter((row) => isCharged(row.stage));
  const total = paid.reduce((sum, row) => sum + row.monthlyCents, 0);
  return (
    <MetaStrip>
      <strong>
        {paid.length} {paid.length === 1 ? "Bought Server" : "Bought Servers"}
      </strong>
      {", "}
      <strong>{perMonth(total)}</strong>
      {" on your plan's invoice"}
      {waiting.length > 0
        ? `, and ${waiting.length} waiting for payment.`
        : "."}
    </MetaStrip>
  );
}
