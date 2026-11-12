import { useState } from "react";

import { Card } from "@/components/console/card";
import { NoListing } from "@/components/console/no-listing";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";

import {
  useRequestLogging,
  useToggleRequestLogging,
  useTraefikPresence,
} from "../monitoring/use-monitoring";
import { RestartTraefikModal } from "./restart-traefik-modal";

/**
 * Whether Traefik is writing an access log at all — and the switch.
 *
 * **Three states, not two, and that is the whole reason this file exists.**
 * `GET /settings/traefik/requests` used to answer `false` both when the
 * `accessLog` block was missing *and* when there was no `traefik.yml` to look in,
 * so "off" and "there is no Traefik on this host" arrived as the same byte.
 * Offering a switch in the second case was a control that wrote nothing and
 * answered `200 false`: the operator flips it, the screen says nothing happened,
 * and there is no explanation anywhere.
 *
 * Now they are split — the route
 * reports `present` alongside `enabled`, and refuses with a 404 rather than a
 * quiet `200 false`. Presence is still established here by asking for the
 * directory listing, which predates that and works; folding it onto `present`
 * would drop a request from this screen and is worth doing next.
 *
 * **Turning it on does not restart Traefik, and this says so instead of doing it.**
 * `accessLog` lives in Traefik's *static* configuration; the file provider's
 * `watch: true` covers `dynamic/` only. So the setting is on disk and the running
 * Traefik has not read it. `POST /settings/traefik/reload` is the restart, and it
 * drops every connection on 80 and 443 — which is why it is a separate, named
 * action behind a confirmation rather than a silent part of saving. A console that
 * bounced a production ingress as a side effect of ticking a box would be right
 * once and unforgivable the other time.
 *
 * **Turning it off is the same trap in reverse, and the off state used to deny
 * it**. The toast
 * said "Restart Traefik to stop recording"; the card that replaced the on state
 * said "Traefik is running and is not recording requests", with no Restart
 * control, while every request kept landing in the log. So the off state now
 * says only what the file says, offers the same restart the on state does, and
 * — straight after a **Turn off** in this card — says outright that Traefik is
 * still recording.
 *
 * "Straight after, in this card" is the most the console can know, and it is
 * weaker than the question. Whether Traefik has restarted *since the change*
 * would need its container's `State.StartedAt` against the time `traefik.yml`
 * was written, and no route answers either: `runtime-info` reports Traefik's
 * version and `infrastructure-health` up or down. Rejected: inferring it from
 * the reload mutation, which answers before Docker has restarted anything and
 * says nothing about a restart done from a shell.
 */
export function LoggingCard({ logging }: { logging: boolean }) {
  const state = useRequestLogging();
  const presence = useTraefikPresence();
  const toggle = useToggleRequestLogging();
  const [restartOpen, setRestartOpen] = useState(false);

  // This card switched logging off and has not restarted Traefik since. The
  // only moment the console can say Traefik is certainly still recording — so
  // the restart below resets the toggle, or the warning would outlive the
  // restart that answered it until the page reloads.
  const turnedOffHere = toggle.isSuccess && toggle.variables === false;

  // A 404 or an empty tree is "no Traefik here" — and only those
  // This used to
  // read *any* error as absence, so the built-in member, whose role cannot list
  // the Traefik directory, was told the host had no Traefik and that its setup
  // may have skipped installing it, on a host where it plainly had. A 403 is
  // about the reader and says so; any other failure is about neither the host
  // nor the reader, and claims nothing either way. Anything that lists files
  // means there is a Traefik, whatever the switch says.
  const failure = presence.error;
  const refused = isApiError(failure) && failure.isForbidden;
  const absent =
    (isApiError(failure) && failure.isMissing) ||
    (presence.data !== undefined && presence.data.length === 0);

  if (state.isPending || presence.isPending) {
    return (
      <Card>
        <Card.Body>
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-5 w-64" />
            <Skeleton className="h-5 w-80" />
          </div>
        </Card.Body>
      </Card>
    );
  }

  if (refused) {
    // `errorMessage()` rather than a sentence of this card's: it is the
    // console's one role-refusal line, and it is also the one that knows a
    // *banned* account is refused with the same status and a different reason.
    return (
      <Card>
        <Card.Header
          title={errorMessage(failure)}
          sub="Whether this host records requests is read from its Traefik configuration directory, and that read was refused — so this card cannot say whether request logging is on, or offer the switch."
          headingLevel={2}
        />
      </Card>
    );
  }

  if (!absent && failure !== null) {
    return (
      <Card>
        <Card.Header
          title="Cloudgate could not tell whether this host has Traefik"
          sub="Listing the Traefik configuration directory failed, so this card cannot say whether request logging is on, or offer the switch."
          headingLevel={2}
        />
        <Card.Body className="flex flex-wrap items-center gap-3">
          <p className="min-w-0 flex-1 text-body text-tx-2">
            {errorMessage(failure)}
          </p>
          <Button size="sm" onClick={() => void presence.refetch()}>
            Try again
          </Button>
        </Card.Body>
      </Card>
    );
  }

  if (absent) {
    return (
      <Card>
        <Card.Body flush>
          <NoListing icon="globe" title="There is no Traefik configuration on this host">
            Request analytics are read out of Traefik&rsquo;s own access log, and
            Cloudgate cannot find a <code className="font-mono">traefik.yml</code>{" "}
            here — so there is nothing to switch on and nothing to read. Traefik is
            installed by a Server&rsquo;s setup run; a host provisioned with a
            custom command may have skipped that step. Until then this screen has no
            data source, which is a different thing from an Organization with no
            traffic.
          </NoListing>
        </Card.Body>
      </Card>
    );
  }

  if (!logging) {
    return (
      <Card>
        <Card.Header
          title="Request logging is off"
          sub="Traefik is configured not to write an access log."
          headingLevel={2}
        />
        <Card.Body className="flex flex-col items-start gap-3.5">
          {turnedOffHere ? (
            <div className="flex flex-col items-start gap-2.5 rounded-lg border border-warn-line bg-warn-tint p-3">
              <p className="text-body text-tx">
                <strong className="font-medium">
                  Traefik is still recording every request
                </strong>{" "}
                until it restarts. The{" "}
                <code className="font-mono">accessLog</code> block is gone from{" "}
                <code className="font-mono">traefik.yml</code>, but that is its
                static configuration and the running process read the old one
                when it started.
              </p>
              <Button size="sm" onClick={() => setRestartOpen(true)}>
                Restart Traefik
              </Button>
            </div>
          ) : null}
          <p className="text-body text-tx-2">
            Turning it on adds an{" "}
            <code className="font-mono">accessLog</code> block to{" "}
            <code className="font-mono">traefik.yml</code>, which is Traefik&rsquo;s
            static configuration —{" "}
            <strong className="font-medium text-tx">
              so Traefik has to restart before a single request is recorded
            </strong>
            . Cloudgate will not restart it for you: that drops every connection on
            80 and 443, and it is your call when.
          </p>
          <Button
            variant="pri"
            size="sm"
            disabled={toggle.isPending}
            onClick={() => {
              void toggle
                .mutateAsync(true)
                .then((written) =>
                  written
                    ? toast.done(
                        "Request logging is configured. Restart Traefik to start recording.",
                      )
                    : toast.warn(
                        "Cloudgate could not edit traefik.yml, so nothing changed.",
                      ),
                )
                .catch((error: unknown) => toast.error(error));
            }}
          >
            Turn on request logging
          </Button>
        </Card.Body>
        <Card.Footer>
          Switched it off and requests are still being logged?{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() => setRestartOpen(true)}
          >
            Restart Traefik
          </button>{" "}
          — the switch edits the static config and the running process has
          already read it.
        </Card.Footer>

        <RestartTraefikModal
          open={restartOpen}
          onOpenChange={setRestartOpen}
          onRestarted={() => toggle.reset()}
        />
      </Card>
    );
  }

  return (
    <Card>
      <Card.Header
        title="Request logging is on"
        sub="Traefik is configured to write a JSON access log."
        headingLevel={2}
        actions={
          <Button
            size="xs"
            disabled={toggle.isPending}
            onClick={() => {
              void toggle
                .mutateAsync(false)
                .then(() =>
                  toast.done(
                    "Request logging is switched off in the configuration. Restart Traefik to stop recording.",
                  ),
                )
                .catch((error: unknown) => toast.error(error));
            }}
          >
            Turn off
          </Button>
        }
      />
      <Card.Body>
        <p className="text-body text-tx-2">
          The analytics below are computed by reading that log on every request.
          Cloudgate keeps an index of where each hour begins in it, so it seeks
          straight to the window you asked for instead of reading everything before
          it — what costs is the window, not the size of the log behind it. A wide
          window on a busy host is still slower, and paging through the table does
          not make it cheaper, because every page reads the window again.
          Cloudgate&rsquo;s own dashboard traffic is filtered out of every figure.
        </p>
      </Card.Body>
      <Card.Footer>
        Changed the setting and nothing arrived?{" "}
        <button
          type="button"
          className="underline underline-offset-2"
          onClick={() => setRestartOpen(true)}
        >
          Restart Traefik
        </button>{" "}
        — the switch edits the static config and the running process has already
        read it.
      </Card.Footer>

      <RestartTraefikModal
          open={restartOpen}
          onOpenChange={setRestartOpen}
          onRestarted={() => toggle.reset()}
        />
    </Card>
  );
}
