"use client";

import { useMemo, useState } from "react";

import { Card } from "@/components/console/card";
import { LinkButton } from "@/components/console/link-button";
import { Cols } from "@/components/console/cols";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { ServerTable } from "@/components/console/rows/server-row";
import { SearchInput } from "@/components/console/search-input";
import { Skeleton } from "@/components/console/skeleton";
import { Toolbar, ToolbarGap } from "@/components/console/toolbar";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { useServers } from "@/lib/api/use-servers";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { LocalShellCard } from "../local/local-shell-card";

import { PurchasesCard } from "../buy/purchases-card";
import { useBoughtServerOffer } from "../buy/use-bought-servers";
import { SERVER_CREATE_REFUSAL } from "../use-server";
import { AddServerDialogs } from "./add-server-dialogs";
import { FleetAside } from "./fleet-aside";

/**
 * Every Server in the Organization.
 *
 * The reference's fleet screen (`e-console.html:2915-2961`) is built around
 * Terraform-provisioned machines: an origin badge, a provider, a region, a size, a
 * cost, a provisioning pill, an import and an export, and a cloud-accounts table
 * under it. **None of that exists** (`00-INDEX.md`, locked decision 1), so what is
 * kept is the shape — the dense table, the search row, the aside — and the columns
 * are the ones with a column behind them. F07's `ServerTable` already made those
 * choices and states them; this screen adds nothing to it.
 *
 * Two of the brief's columns are still absent and it is worth saying which:
 *
 * - **Docker version and Swarm role.** Both come from `GET /servers/:id/audit`,
 *   which uploads a script and runs it over SSH. A column of them would open one
 *   SSH session per row on every visit to this page — and `keys.ts` says out loud
 *   that the audit is only run when somebody asks. They are on each Server's
 *   Infrastructure tab, where asking is what opening the tab means.
 * - **Service count and utilisation.** Nothing indexes services by Server. An
 *   Environment names its own and each entry carries a `serverId`
 * so the count is
 *   *derivable* — by reading every Environment in the Organization and grouping the
 *   result, which is a page of requests for one column. Telemetry exists only for
 *   Servers set up for monitoring — see `endpoints/monitoring.ts`. A column that is
 *   empty for every row is not a column, and one that costs the fleet is worse.
 *
 * **The SSH keys live here**, in a dialog, for F08's reason about Tags: a key has
 * one use, the route tree has no `/ssh-keys`, and the dialog that asks which key a
 * new Server uses is one click away.
 */
export function FleetScreen() {
  const [query, setQuery] = useState("");
  // `POST /servers` is `server: ['create']`, off for the base member —
  // the Organization home's Add a Server already read it.
  const canCreate = usePermission({ server: ["create"] });
  const [adding, setAdding] = useState(false);
  const [managingKeys, setManagingKeys] = useState(false);
  /** Every opening mounts a fresh form — `useApiForm` reads `defaultValues` once
   *  (F09's add-a-domain defect). */
  const [opening, setOpening] = useState(0);

  const servers = useServers();
  // Whether this visit showed the skeleton: only then does the list fade in
  // where it stood. A list already in the cache is simply there.
  const [arrives] = useState(() => servers.isPending);
  const arrival = arrives ? "animate-fade" : undefined;
  // Hosted only, and only with the provider's tokens set (ADR-0071): anywhere
  // else the action is not there at all, rather than off.
  const buying = useBoughtServerOffer();
  // Memoized, so the filter below does not re-run on every render just because
  // `?? []` made a new array. TanStack's own `data` is stable; the fallback is not.
  const rows = useMemo(() => servers.data ?? [], [servers.data]);

  const matching = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((row) =>
      [
        row.name,
        row.description ?? "",
        // **`ipAddress:port`, not just the address.** The Address column renders
        // the two joined, so a Server on 2222 shows `localhost:2222` — and typing
        // 2222 matched nothing, because the port was not in the haystack. Found
        // by driving it. A search has to match what the row on screen says.
        `${row.ipAddress}:${row.port}`,
        row.username,
      ]
        .join(" ")
        .toLowerCase()
        .includes(needle),
    );
  }, [rows, query]);

  function openAdd() {
    setOpening((n) => n + 1);
    setAdding(true);
  }

  return (
    <Page>
      <PageHeader
        title="Servers"
        icon="hdd"
        lede="Every machine this Organization deploys onto, reached over SSH."
        actions={
          <>
            <Button onClick={() => setManagingKeys(true)}>
              <Icon name="key" size={15} />
              SSH keys
            </Button>
            {buying.offered ? (
              canCreate.allowed ? (
                <LinkButton href="/servers/buy">
                  <Icon name="cash" size={15} />
                  Buy a Server
                </LinkButton>
              ) : (
                <Button disabled title={SERVER_CREATE_REFUSAL}>
                  <Icon name="cash" size={15} />
                  Buy a Server
                </Button>
              )
            ) : null}
            <Button
              variant="pri"
              disabled={!canCreate.allowed}
              title={canCreate.allowed ? undefined : SERVER_CREATE_REFUSAL}
              onClick={() => canCreate.allowed && openAdd()}
            >
              <Icon name="plus" size={15} />
              Add a Server
            </Button>
          </>
        }
      />

      <Cols
        aside={<FleetAside servers={rows} pending={servers.isPending} />}
        asideLabel="About this fleet"
      >
        <Toolbar>
          <SearchInput
            label="Search Servers"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name, address or SSH user"
          />
          <ToolbarGap />
        </Toolbar>

        <PurchasesCard enabled={buying.offered} />

        <Card>
          {/* A refusal and a skeleton are both answered before `rows.length === 0`
              is looked at, so a 403 never renders an empty state — which would be a
              claim about this Organization's fleet made because a request failed
              (F10's `ResourceList`, rule 3). */}
          {servers.error ? (
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(servers.error)}
              </p>
            </Card.Body>
          ) : servers.isPending ? (
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          ) : (
            <>
              {rows.length > 0 ? (
                <MetaStrip className={arrival}>
                  Showing <strong>{matching.length}</strong> of{" "}
                  <strong>{rows.length}</strong>{" "}
                  {rows.length === 1 ? "Server" : "Servers"}.
                </MetaStrip>
              ) : null}
              <Card.Body flush className={arrival}>
                <ServerTable
                  servers={matching}
                  empty={
                    rows.length === 0 ? (
                      <EmptyState
                        icon="hdd"
                        title="No Servers yet"
                        action={
                          <Button
                            size="sm"
                            variant="pri"
                            disabled={!canCreate.allowed}
                            title={
                              canCreate.allowed
                                ? undefined
                                : SERVER_CREATE_REFUSAL
                            }
                            onClick={() => canCreate.allowed && openAdd()}
                          >
                            Add a Server
                          </Button>
                        }
                      >
                        Add a Server to give your Projects a machine to deploy
                        onto, reached over SSH.
                      </EmptyState>
                    ) : (
                      <EmptyState
                        icon="search"
                        title="No Server matches that"
                        action={
                          <Button size="sm" onClick={() => setQuery("")}>
                            Clear the search
                          </Button>
                        }
                      >
                        Clear the search, or try a name, an address with its
                        port, or an SSH user.
                      </EmptyState>
                    )
                  }
                />
              </Card.Body>
            </>
          )}
        </Card>

        {/* Under the fleet, because it is not part of it: the platform host has
            no Server row, is never returned by `GET /servers`, and cannot be
            deployed onto by name. It is here because it is a machine in this
            install that an operator sometimes needs a shell on, and until now
            the console offered no way to ask for one. */}
        <LocalShellCard />
      </Cols>

      <AddServerDialogs
        opening={opening}
        adding={adding}
        onAddingChange={setAdding}
        managingKeys={managingKeys}
        onManagingKeysChange={setManagingKeys}
        servers={rows}
      />
    </Page>
  );
}
