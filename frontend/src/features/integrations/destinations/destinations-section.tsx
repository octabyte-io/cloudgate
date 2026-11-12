"use client";

import { ResourceList } from "@/components/console/resource-list";
import { useProbeServerPicker } from "@/lib/forms/probe-server-picker";
import { useInvalidate } from "@/lib/api/use-invalidate";

import { useDestinations } from "../use-integrations";
import { destinationSpec } from "./destinations-spec";

/**
 * Destinations: the same `ResourceList` as registries, with a test in its form.
 *
 * The note above the table is the one thing worth saying on this screen that is
 * not a field: **this table is configuration, not contents**. A destination that
 * has been failing for a fortnight looks exactly like one that has been working,
 * and the test button is the only way to ask from here.
 *
 * Listing a bucket's objects is no longer the gap it was when this screen was
 * built — `GET /destinations/:id/objects`
 * exists now and the
 * volume restore flow picks from it. It is deliberately not surfaced *here*,
 * where the question is whether the credentials are right, not what is stored.
 */
export function DestinationsSection() {
  const invalidate = useInvalidate();
  const query = useDestinations();
  // On the Hosted instance a test runs from a Server the dialog asks for.
  const probeFrom = useProbeServerPicker();

  return (
    <ResourceList
      spec={destinationSpec(invalidate.destinations, probeFrom)}
      query={query}
      note={
        <p className="border-b border-line bg-panel-2 px-4 py-2.5 text-meta text-tx-2">
          This table says which buckets are configured, not whether anything has
          been written to them. Open one and press{" "}
          <strong className="font-medium text-tx">Test connection</strong> to
          check it still answers — the backups and volume restore flows list
          what is actually in a bucket.
        </p>
      }
    />
  );
}
