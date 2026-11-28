import { Card } from "@/components/console/card";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import type {
  BoughtServerLineKind,
  BoughtServerView,
} from "@/lib/api/endpoints/bought-servers";

import { countryName, sizeName } from "../buy/buy-model";
import { perMonth } from "./per-month";

/** What each line of a Bought Server's charge is called. */
const LINE_LABEL: Record<BoughtServerLineKind, string> = {
  server: "Server",
  backups: "Backups",
  storage: "Extra storage",
};

/**
 * The Bought Server tab's aside: **What you pay**, each line it is charged
 * for and their total, and **About this Server**, its Location, Server image
 * and size. Each is named by what it is, never by the provider's code; one
 * the catalogue could not name shows as a dash.
 */
export function BoughtServerFacts({ view }: { view: BoughtServerView }) {
  return (
    <>
      <Card>
        <Card.Header
          title="What you pay"
          sub="On your plan's invoice, monthly in advance."
          headingLevel={2}
        />
        <Card.Body>
          <KVList>
            {view.lines.map((line) => (
              <KVRow
                key={line.kind}
                label={LINE_LABEL[line.kind]}
                value={perMonth(line.monthlyCents)}
              />
            ))}
            <KVRow
              label="Total"
              value={perMonth(view.monthlyCents)}
              className="font-semibold"
            />
          </KVList>
        </Card.Body>
      </Card>
      <Card>
        <Card.Header title="About this Server" headingLevel={2} />
        <Card.Body>
          <KVList>
            <KVRow
              label="Location"
              value={
                view.location ? (
                  `${view.location.city}, ${countryName(view.location.country)}`
                ) : (
                  <Dash word="Unknown" />
                )
              }
            />
            <KVRow
              label="Server image"
              value={view.image ?? <Dash word="Unknown" />}
            />
            <KVRow
              label="Size"
              wrap
              value={view.size ? sizeName(view.size) : <Dash word="Unknown" />}
            />
          </KVList>
        </Card.Body>
      </Card>
    </>
  );
}
