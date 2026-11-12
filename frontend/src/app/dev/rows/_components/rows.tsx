import { Button } from "@/components/ui/button";
import { Card } from "@/components/console/card";
import { MetaStrip } from "@/components/console/meta-strip";
import { DeploymentTable } from "@/components/console/rows/deployment-row";
import { ServerTable } from "@/components/console/rows/server-row";
import { ServiceTable } from "@/components/console/rows/service-row";

import { Section } from "../../primitives/_components/shell";
import { DEPLOYMENTS, ownerOf, SERVERS, SERVICES } from "../_lib/fixtures";

/**
 * The three row shapes, each in a card that owns its edges — which is how every
 * screen in the product will hold them, and the only way to see that the table's
 * own horizontal scroll works rather than the page's.
 */
export function RowsGallery() {
  return (
    <>
      <Section
        title="Servers"
        source="e-console.html:2630-2666"
        blurb="Name and description, status, the SSH endpoint including its port, which of the two roles it plays, and when it was added. Sorts by name, status or age. The reference's Origin, Region, Size, Cost, Services and CPU columns need provisioning, a service list or the metrics gateway, and none of them exists — a column of em dashes is not a column."
      >
        <Card tone="plain">
          <MetaStrip>
            <strong>{SERVERS.length}</strong> Servers ·{" "}
            <strong>
              {SERVERS.filter((s) => s.serverStatus === "active").length}
            </strong>{" "}
            active
          </MetaStrip>
          <Card.Body flush>
            <ServerTable servers={SERVERS} />
          </Card.Body>
        </Card>

        <Card tone="plain">
          <Card.Header title="With nothing in it" headingLevel={3} />
          <Card.Body flush>
            <ServerTable servers={[]} />
          </Card.Body>
        </Card>
      </Section>

      <Section
        title="Services"
        source="e-console.html:2668-2694"
        blurb="One row shape for the three things an Environment holds. The type column carries the engine's own name — PostgreSQL, not postgres — and every optional field renders as “None” with the word in an sr-only span rather than as a blank cell, because a bare em dash tells a screen reader nothing."
      >
        <Card tone="plain">
          <Card.Body flush>
            <ServiceTable services={SERVICES} selectable label="Services in production" />
          </Card.Body>
        </Card>
      </Section>

      <Section
        title="Deployments"
        source="e-console.html:2696-2712"
        blurb="Newest first, because that is the only order anyone wants. Duration is derived from startedAt and finishedAt — a run still going measures against now, and a queued one has no duration at all. The Service column appears only when the caller can name what was deployed."
      >
        <Card tone="plain">
          <Card.Header
            title="On a screen that knows the service"
            sub="Both optional columns on: an owner to link to, and the screen's own control."
            headingLevel={3}
          />
          <Card.Body flush>
            <DeploymentTable
              deployments={DEPLOYMENTS}
              owner={ownerOf}
              action={(row) => (
                <Button size="xs" aria-disabled={!row.logPath}>
                  Log
                </Button>
              )}
            />
          </Card.Body>
        </Card>

        <Card tone="plain">
          <Card.Header
            title="On a screen that does not"
            sub="An Application's own tab already knows; it does not print its own name in every row."
            headingLevel={3}
          />
          <Card.Body flush>
            <DeploymentTable deployments={DEPLOYMENTS} />
          </Card.Body>
        </Card>
      </Section>
    </>
  );
}
