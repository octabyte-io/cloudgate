"use client";

import { Banner, BannerRow } from "@/components/console/banner";
import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Cols } from "@/components/console/cols";
import { MetaStrip } from "@/components/console/meta-strip";
import { PageHeader } from "@/components/console/page-header";
import { SectionHeading } from "@/components/console/section-heading";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import { Row } from "./shell";

export function SurfacesGallery() {
  return (
    <>
      <Row label="PageHeader" className="block">
        <div className="rounded-xl border border-line bg-ground p-4">
          <PageHeader
            title="checkout-api"
            icon="box"
            badges={
              <>
                <StatusPill status="running" />
                <Chip variant="mono">ghcr.io/octabyte/checkout-api:2f9c1ab</Chip>
              </>
            }
            lede="An Application in the production Environment of the Storefront Project, running on two Servers."
            strap="Last Deployment finished 14 minutes ago."
            actions={
              <>
                <Button variant="gh">
                  <Icon name="term" />
                  Open a terminal
                </Button>
                <Button variant="pri">
                  <Icon name="rocket" />
                  Deploy
                </Button>
              </>
            }
          />
        </div>
      </Row>

      <Row label="SectionHeading" className="block">
        <SectionHeading
          title="Environments"
          lede="Every Environment in this Project, and what is deployed to each."
          actions={
            <Button variant="gh" size="sm">
              <Icon name="plus" />
              New Environment
            </Button>
          }
        />
      </Row>

      <Row label="Card — header, meta strip, flush body, footer" className="block">
        <Cols
          asideLabel="Card variants"
          aside={
            <>
              <Card tone="plain">
                <Card.Header title="Plain" sub="No shadow, for a card inside a card" />
                <Card.Body className="text-body text-tx-2">
                  Two shadows at two depths say the surfaces are at two depths.
                  Inside another surface they are not.
                </Card.Body>
              </Card>
              <Card>
                <Card.Body className="text-body text-tx-2">
                  A card with no header at all — just a body.
                </Card.Body>
              </Card>
            </>
          }
        >
          <Card>
            <Card.Header
              title="Deployments"
              sub="The last five, newest first"
              actions={
                <Button variant="qt" size="sm">
                  View all
                </Button>
              }
            />
            <MetaStrip>
              <strong>5</strong> Deployments · <strong>1</strong> failed ·
              triggered by push to <strong>main</strong>
            </MetaStrip>
            <Card.Body flush>
              <ul className="divide-y divide-line">
                {[
                  { sha: "2f9c1ab", status: "done" as const, when: "14 minutes ago" },
                  { sha: "8d13e70", status: "error" as const, when: "2 hours ago" },
                  { sha: "b41a55c", status: "cancelled" as const, when: "yesterday" },
                ].map((row) => (
                  <li
                    key={row.sha}
                    className="flex h-row items-center gap-3 px-4 text-ui"
                  >
                    <span className="font-mono text-tx">{row.sha}</span>
                    <StatusPill status={row.status} />
                    <span className="ml-auto text-tx-2">{row.when}</span>
                  </li>
                ))}
              </ul>
            </Card.Body>
            <Card.Footer>
              Deployments are kept for 30 days, then only their result is kept.
            </Card.Footer>
          </Card>
        </Cols>
      </Row>

      <Row label="Banner — collapsible, counted, tone-bulleted" className="block">
        <Banner title="Three things need attention" icon="alert" count={3}>
          <BannerRow
            tone="bad"
            title="checkout-api failed its last Deployment"
            description="The build exited 1 while running `pnpm build`. The previous Deployment is still serving traffic."
            action={
              <Button variant="gh" size="sm">
                Read the log
              </Button>
            }
          />
          <BannerRow
            tone="warn"
            title="swarm-prod-2 has not reported in 9 minutes"
            description="Its last heartbeat named ghcr.io/octabyte/checkout-api@sha256:9f2c4d1e8b7a6053f1c2d3e4a5b6c7d8e9f0a1b2c3d4e5f60718293a4b5c6d7e as the running image."
            action={
              <Button variant="gh" size="sm">
                Open the Server
              </Button>
            }
          />
          <BannerRow
            tone="info"
            title="Two Applications have no health check"
            description="Without one, a container that is up but not serving still counts as running."
          />
        </Banner>
      </Row>
    </>
  );
}
