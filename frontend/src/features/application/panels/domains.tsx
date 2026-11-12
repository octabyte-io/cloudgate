"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { CopyButton } from "@/components/console/copy-button";
import { MetaStrip } from "@/components/console/meta-strip";
import { Button } from "@/components/ui/button";
import type { Domain } from "@/lib/api/endpoints/domains";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { kindRefusals } from "../config-kind";
import {
  CloudDomainFormModal,
  CloudRemoveDomainModal,
} from "../domains/cloud-domain-modals";
import { CloudDomainsCard } from "../domains/cloud-domains-card";
import { DeleteDomainModal } from "../domains/delete-domain-modal";
import { DomainFormModal } from "../domains/domain-form-modal";
import { DomainsCard } from "../domains/domains-card";
import { useTraefikConfigStatus } from "../traefik-status/use-config-status";
import {
  useApplicationDomains,
  useCreateDomain,
  useUpdateDomain,
} from "../domains/use-domains";
import { useApplication } from "../use-application";
import { onGoogleCloud } from "@/lib/api/endpoints/applications";

/**
 * The hosts this Application answers on.
 *
 * The four dialogs are held **at panel level**, not inside a row: a dialog mounted
 * in a table cell unmounts the moment the table re-sorts or the list refetches,
 * which closes it under the person using it (F08 learned this on the Projects
 * list).
 *
 * The reference's per-row "Status" column is **absent** and the reasoning is in
 * `domain-columns.tsx`: nothing records whether Traefik is serving a host or
 * whether a certificate was issued, so the honest replacement is a check that
 * actually asks a resolver — which lives in the add/edit dialog beside the record
 * it tells you to create.
 *
 * H-38 changed exactly half of that. Cloudgate now knows when Traefik **refused**
 * a router, because it reads the line Traefik wrote about it — and still knows
 * nothing about a router Traefik accepted, because Traefik logs nothing for one.
 * So what arrived is a mark on the rows that stopped being served and no column
 * at all, which is the same judgement applied to a fact that now exists on one
 * side only.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const domains = useApplicationDomains(id);
  // H-38/H-62. Read here rather than inside the card so the card stays usable
  // by F12's Compose stacks, which have no per-Application Traefik config.
  const traefik = useTraefikConfigStatus(id);
  // The two writes are held here and handed to the dialog, which takes them as
  // props so that F12's Compose stacks can use the same dialog with their own
  // parent id (`domain-form-modal.tsx` explains).
  const create = useCreateDomain(id);
  const update = useUpdateDomain(id);

  const [editing, setEditing] = useState<Domain | null>(null);
  const [removing, setRemoving] = useState<Domain | null>(null);

  /**
   * The add dialog, and **which** opening of it.
   *
   * `useApiForm` reads `defaultValues` exactly once, so a dialog that stays
   * mounted across a close keeps whatever was typed into it — someone who opened
   * it, generated a host, cancelled, and opened it again found the old host still
   * there and typed *into* it. The counter is the key, so every opening mounts a
   * fresh form while closing still animates out on the instance that was open.
   */
  const [adding, setAdding] = useState(false);
  const [opening, setOpening] = useState(0);

  function openAddDialog() {
    setOpening((n) => n + 1);
    setAdding(true);
  }

  const row = application.data;
  const serverIp = row?.server?.ipAddress ?? null;
  // A web-private takes no Domain, nor does a worker, and the
  // panel says why in place of the list, so the reason is where the control
  // would have been.
  const refused = kindRefusals(row?.configKind)?.domain ?? null;
  // A cloud Service's Domains are on its AWS load balancer, each with
  // its own ACM certificate and the DNS records to copy, not on Traefik.
  const cloud = row?.cloudPlace != null;
  // A static site on AWS has its one Domain on its own CloudFront
  // distribution, and that distribution's name as its generated Domain.
  // One on Google Cloud has none, and answers nowhere until a Domain
  // is added.
  const staticSite = cloud && row?.configKind === "static";
  const cloudCdn = staticSite && onGoogleCloud(row?.cloudPlace);
  const cloudFront = staticSite && !cloudCdn;
  // S11: a `web` on Cloud Run has its `run.app` address as its
  // generated Domain.
  const cloudRun = cloud && onGoogleCloud(row?.cloudPlace);
  const full =
    cloudFront && (domains.data?.length ?? 0) > 0
      ? "A static site on AWS takes one Domain: CloudFront serves one certificate. Edit or remove the one it has."
      : null;

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="Where this Application answers from the internet, and which container port each host routes to."
        actions={
          <Button
            variant="pri"
            onClick={openAddDialog}
            disabled={!row || refused !== null || full !== null}
            title={refused ?? full ?? undefined}
          >
            <Icon name="plus" size={15} />
            Add a domain
          </Button>
        }
      />

      <Cols
        aside={
          // A Service in a Cloud account joins no overlay (the live walk),
          // so it has no internal address to show, but for a Private
          // web service in one, reached by private DNS.
          row && (!cloud || row.internalAddress) ? (
            <InternalAddressCard
              appName={row.appName}
              address={row.internalAddress}
              cloud={cloud}
              google={onGoogleCloud(row.cloudPlace)}
            />
          ) : undefined
        }
        asideLabel="How it is reached internally"
      >
        {refused !== null ? (
          <MetaStrip>{refused}</MetaStrip>
        ) : cloud ? (
          <CloudDomainsCard
            parent={{ applicationId: id }}
            domains={domains.data ?? []}
            cloudFront={cloudFront}
            cloudRun={cloudRun}
            cloudCdn={cloudCdn}
            generated={
              (cloudRun
                ? row?.cloudRunAddress
                : row?.cloudDistributionDomain) ?? null
            }
            onAdd={openAddDialog}
            onEdit={setEditing}
            onRemove={setRemoving}
          />
        ) : (
          <DomainsCard
            domains={domains}
            status={traefik}
            canAdd={Boolean(row)}
            onAdd={openAddDialog}
            onEdit={setEditing}
            onRemove={setRemoving}
          />
        )}
      </Cols>

      {row && refused === null && cloud ? (
        <>
          <CloudDomainFormModal
            key={`add-${opening}`}
            domain={null}
            cloudFront={cloudFront}
            cloudRun={cloudRun}
            open={adding}
            onOpenChange={setAdding}
            create={(input) => create.mutateAsync(input)}
            update={(domainId, input) =>
              update.mutateAsync({ domainId, input })
            }
          />
          <CloudDomainFormModal
            key={editing?.domainId ?? "none"}
            domain={editing}
            cloudFront={cloudFront}
            cloudRun={cloudRun}
            open={editing !== null}
            onOpenChange={(next) => {
              if (!next) setEditing(null);
            }}
            create={(input) => create.mutateAsync(input)}
            update={(domainId, input) =>
              update.mutateAsync({ domainId, input })
            }
          />
          <CloudRemoveDomainModal
            parent={{ applicationId: id }}
            domain={removing}
            cloudFront={cloudFront}
            cloudRun={cloudRun}
            open={removing !== null}
            onOpenChange={(next) => {
              if (!next) setRemoving(null);
            }}
          />
        </>
      ) : row && refused === null ? (
        <>
          <DomainFormModal
            key={`add-${opening}`}
            appName={row.appName}
            serverIp={serverIp}
            serverId={row.serverId}
            domain={null}
            open={adding}
            onOpenChange={setAdding}
            running={row.applicationStatus === "running"}
            create={(input) => create.mutateAsync(input)}
            update={(domainId, input) =>
              update.mutateAsync({ domainId, input })
            }
          />
          {/* Keyed on the domain, so opening a second row's dialog remounts the
              form rather than reusing the first row's `defaultValues` — which
              react-hook-form reads exactly once. */}
          <DomainFormModal
            key={editing?.domainId ?? "none"}
            appName={row.appName}
            serverIp={serverIp}
            serverId={row.serverId}
            domain={editing}
            open={editing !== null}
            onOpenChange={(next) => {
              if (!next) setEditing(null);
            }}
            create={(input) => create.mutateAsync(input)}
            update={(domainId, input) =>
              update.mutateAsync({ domainId, input })
            }
          />
          <DeleteDomainModal
            applicationId={id}
            domain={removing}
            open={removing !== null}
            onOpenChange={(next) => {
              if (!next) setRemoving(null);
            }}
          />
        </>
      ) : null}
    </Page>
  );
}

/**
 * How other services reach this one without a domain at all.
 *
 * Kept from the reference (`e-console.html:4270-4275`) because it answers the
 * question the empty state raises: if nothing points here, how does the API talk to
 * it? The network name is `cloudgate-network`, the overlay every Application
 * joins (`CLOUDGATE_NETWORK` in the backend), and the host is the
 * Application's immutable `appName`.
 */
function InternalAddressCard({
  appName,
  address,
  cloud,
  google,
}: {
  appName: string;
  /**
   * A Private web service's whole base URL, which its callers are given;
   * `null` on any other kind, whose port is whatever it listens on.
   */
  address: string | null;
  /** In a Cloud account: reached by its Environment network's private DNS. */
  cloud: boolean;
  /**
   * On Google Cloud: its address is its Cloud Run service's own
   * `run.app` URL, resolved inside the network by its private zone.
   */
  google: boolean;
}) {
  if (address !== null && cloud) {
    return (
      <Card>
        <Card.Header
          title="Internal address"
          sub="The only way this Service is reached."
          headingLevel={2}
        />
        <Card.Body>
          <KVList>
            <KVRow
              label="Address"
              value={address}
              title={address}
              mono
              action={<CopyButton value={address} label="internal address" />}
            />
            <KVRow label="Network" value="This Environment network" />
            <KVRow
              label="Reachable by"
              value="The Services of this Environment"
            />
          </KVList>
          <p className="mt-3 text-meta text-tx-2">
            {google
              ? "For a few minutes after it is first made, callers inside the Environment get a 404 while Google sets it up. "
              : "Only its healthy tasks are listed, and a caller may reach an old task for a few seconds after a deploy. "}
            Type the address whole into the variable the caller reads its URL
            from.
          </p>
        </Card.Body>
      </Card>
    );
  }
  if (address !== null) {
    return (
      <Card>
        <Card.Header
          title="Internal address"
          sub="The only way this Service is reached."
          headingLevel={2}
        />
        <Card.Body>
          <KVList>
            <KVRow
              label="Address"
              value={address}
              title={address}
              mono
              action={<CopyButton value={address} label="internal address" />}
            />
            <KVRow label="Network" value="cloudgate-network" mono />
            <KVRow label="Reachable by" value="The Services on its Server" />
          </KVList>
          <p className="mt-3 text-meta text-tx-2">
            Any Service on this Server reaches it at that base URL, other
            Projects&rsquo; included. Type it whole into the variable the caller
            reads its URL from.
          </p>
        </Card.Body>
      </Card>
    );
  }
  return (
    <Card>
      <Card.Header
        title="Internal address"
        sub="How other services reach this one."
        headingLevel={2}
      />
      <Card.Body>
        <KVList>
          <KVRow label="Host" value={appName} title={appName} mono />
          <KVRow label="Network" value="cloudgate-network" mono />
          <KVRow label="Reachable by" value="Every service on the overlay" />
        </KVList>
        <p className="mt-3 text-meta text-tx-2">
          A service in the same Swarm reaches this one at that host on whatever
          port it listens on — no domain, no certificate and no trip through
          Traefik.
        </p>
      </Card.Body>
    </Card>
  );
}
