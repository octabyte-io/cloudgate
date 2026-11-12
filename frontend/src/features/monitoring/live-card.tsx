import { useState } from "react";

import { Card } from "@/components/console/card";
import { Picker } from "@/components/console/picker";
import { rangeBounds, type TimeRangeValue } from "@/components/console/time-range";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { dockerApi } from "@/lib/api/endpoints/docker";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { useQuery } from "@tanstack/react-query";

import { ContainerHistory } from "./live/container-history";
import { HostHistory } from "./live/host-history";
import { HostSetupModal } from "./live/host-setup-modal";
import { LiveFooter } from "./live/live-footer";
import { LiveReadings } from "./live/live-readings";
import { liveTargetCopy, targetOptions } from "./live/target-options";
import { useLiveStream } from "./live/use-live-stream";
import { stopCollecting } from "./setup/metrics-config-spec";
import {
  useSetupWebMonitoring,
  useWebServerMetrics,
  useWebServerMonitoring,
} from "./use-monitoring";

/**
 * **One machine, one card** — the platform's own host, as a live stream and as
 * the history Cloudgate stores for it.
 *
 * This file is the shell: it owns the target, the socket, the grace period and the
 * layout. The four things it composes each carry their own reasoning —
 * `live/live-readings.tsx` for what the socket can and cannot answer,
 * `live/host-history.tsx` for the four stored states, `live/target-options.ts` for
 * why the targets are Docker's names, and `live/units.ts` for the arithmetic.
 *
 * ## Why the two are merged rather than sat side by side
 *
 * Once there was only one of them: this card streamed the host from a socket
 * that keeps no queryable history, and `POST /admin/setup-monitoring` stored a
 * config nothing collected against. That config is real now, so the same machine
 * now has **two stores** — a socket frame that is always current, and
 * `server_metric` rows under `serverId: null` with retention and thresholds on
 * them. Putting the second one in a card of its own would have given one host two
 * cards, disagreeing by up to a refresh interval, each labelled "the host
 * Cloudgate runs on". That is the defect to avoid, so the live reading stayed
 * where it is and the stored samples became **its** history.
 *
 * The two are still named separately inside the card, because they are not one
 * mechanism: the reading above is a socket that dies with this card, the plot
 * below is rows on disk that outlive the browser. Blending them into one
 * "monitoring" is what would let somebody think the plot keeps drawing after they
 * navigate away.
 *
 * ## "One machine" is the card, not the copy
 *
 * The card is one card, but its **subject is whatever the picker is on** — the
 * host, or any container running on it — and the copy has to follow it. It did
 * not: the heading `This host` and the line under it were constants, so a
 * container target was drawn under "The machine Cloudgate runs on" with every
 * figure below it the container's
 * Every sentence
 * the card says about its subject — heading, subtitle, and down in
 * `LiveReadings` the Network tile's caption and the hint under a refused stream
 * — now comes from **the one `liveTargetCopy` call below**, whose result is
 * passed down rather than derived again, so they cannot describe two different
 * things at once.
 */
export function LiveCard({ range }: { range: TimeRangeValue }) {
  const { organizationId } = useActiveOrganizationId();
  const [setupOpen, setSetupOpen] = useState(false);
  const [openings, setOpenings] = useState(0);

  const web = useWebServerMonitoring();
  const setup = useSetupWebMonitoring();
  const live = useLiveStream(web.config);
  // Rounded to the minute by `rangeBounds`, which is what keeps the query key
  // stable across renders — see the note in `time-range.tsx`.
  const bounds = rangeBounds(range);
  // Only the host has a stored series here. A container's samples are keyed on a
  // service name and gated on the include list, which is a different question and
  // is answered in words below rather than drawn.
  const history = useWebServerMetrics(web.config, bounds, live.isHost);

  // Every sentence about the subject, from the one target, once.
  const copy = liveTargetCopy(live.target, web.collecting);

  const containers = useQuery({
    queryKey: keys.docker.containers(organizationId, null),
    queryFn: () => dockerApi.containers(null),
    enabled: organizationId !== null,
  });

  function openSetup() {
    setOpenings((count) => count + 1);
    setSetupOpen(true);
  }

  function stopHistory() {
    if (!web.config) return;
    void setup
      .mutateAsync(stopCollecting(web.config))
      .then(() => toast.done("Cloudgate has stopped sampling this host."))
      .catch((error: unknown) => toast.error(error));
  }

  return (
    <Card>
      <Card.Header
        title={copy.title}
        sub={copy.sub}
        headingLevel={2}
        actions={
          <>
            <Picker
              options={targetOptions(containers.data ?? [])}
              value={live.target}
              onValueChange={live.setTarget}
              pending={containers.isPending}
              placeholder="Choose what to sample"
              aria-label="What to sample"
              // The popup is `w-(--anchor-width)`, so the trigger's width *is* the
              // popup's. A container name needs more than the default.
              className="min-w-56"
            />
            {web.collecting ? (
              <Button
                size="xs"
                onClick={openSetup}
                aria-label="Change how this host is sampled"
              >
                Sampling
              </Button>
            ) : null}
          </>
        }
      />
      <Card.Body className="flex flex-col gap-3.5">
        <p className="text-ui text-tx-2">
          Now{" "}
          <span className="text-meta text-tx-3">
            · from the stats stream, every 1.3 seconds while this card is open
          </span>
        </p>
        <LiveReadings
          sample={live.sample}
          status={live.status}
          closeReason={live.closeReason}
          closeCode={live.closeCode}
          ended={live.ended}
          unmeasured={live.unmeasured}
          copy={copy}
          thresholds={live.thresholds}
        />

        {containers.error ? (
          <p className="text-meta text-tx-2">
            Cloudgate could not list this host&rsquo;s containers, so the only
            thing offered above is the host itself: {errorMessage(containers.error)}
          </p>
        ) : containers.data === null ? (
          <p className="text-meta text-tx-2">
            Docker on this host would not list its containers, so the only
            thing offered above is the host itself.
          </p>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-line pt-3.5">
          {live.isHost ? (
            <HostHistory
              range={range}
              config={web.config}
              state={web.state}
              configError={web.error}
              configPending={web.isPending}
              history={history}
              cannotMeasure={live.unmeasured}
              onSetUp={openSetup}
            />
          ) : (
            <ContainerHistory
              config={web.config}
              state={web.state}
              name={live.target}
            />
          )}
        </div>
      </Card.Body>
      <Card.Footer>
        <LiveFooter
          state={web.state}
          config={web.config}
          onStopHistory={stopHistory}
        />
      </Card.Footer>

      {web.config ? (
        <HostSetupModal
          config={web.config}
          state={web.state}
          unmeasured={live.unmeasured}
          openings={openings}
          open={setupOpen}
          onOpenChange={setSetupOpen}
          save={(input) => setup.mutateAsync(input)}
        />
      ) : null}
    </Card>
  );
}
