import type { UseQueryResult } from "@tanstack/react-query";

import { Banner, BannerRow } from "@/components/console/banner";
import { MetaStrip } from "@/components/console/meta-strip";
import { errorMessage } from "@/lib/api/error-message";
import type { TraefikConfigStatus } from "@/lib/api/endpoints/traefik";
import { timeAgo, timeExact } from "@/lib/format/time";

import { describeChain } from "./rejections";

/**
 * What Traefik made of the configuration Cloudgate wrote for this Application
 * (H-38's missing half).
 *
 * **The states are three and they are not one.** Traefik refuses a router — an
 * uncompilable `redirect.regex`, a `:` in a basic-auth username — by dropping
 * it and writing one line to its own log, so the Application answers 404
 * through the catch-all with nothing in the console saying why. The backend
 * reads that log; this says it out loud. What it must never do is turn the two
 * quiet answers into a reassuring one:
 *
 * 1. **A rejection** is a `Banner`, the same shape `panels/overview.tsx` uses
 *    for a failed Deployment, because it is the same kind of fact: something
 *    named, currently true, with somewhere to go and fix it.
 * 2. **`checked` with no rejections** is *"this is what the log said"*. Traefik
 *    logs **nothing at all** for a reload it accepted, so an accepted config and
 *    a reload that has not fired are the same silence and neither can be told
 *    from the other. A tick here would be a claim nothing in the system can
 *    make.
 * 3. **`unavailable`** is "the log could not be read" — no Traefik container to
 *    ask, or nothing has written this config since the backend started. Also not
 *    health, and *different* from 2: one is Traefik being quiet, the other is
 *    Cloudgate not having heard from it.
 *
 * So 2 and 3 are `MetaStrip`s — the console's neutral inset strip, the same one
 * the card above already uses to state a fact about the table — and only 1 gets
 * a colour. **Neither quiet state is a green tick and neither is an alarm**,
 * because both are genuinely "not known", and dressing "not known" as either one
 * is the defect this file closes.
 *
 * **It is not live monitoring and does not pretend to be.** The check runs when
 * Cloudgate *writes* the config, and a byte-identical regeneration produces no
 * log line at all — so a config that was already broken stays unreported until
 * some write changes the file. Every state carries when it was observed for
 * exactly that reason.
 */
export function TraefikConfigStatusNotice({
  query,
}: {
  query: UseQueryResult<TraefikConfigStatus>;
}) {
  // `error` before `isPending` before the data, as everywhere else — and a
  // refusal is answered rather than swallowed. Silently rendering nothing when
  // the read fails is the same silence this component exists to end.
  if (query.error) {
    return (
      <MetaStrip>
        Cloudgate could not read what Traefik made of this Application&rsquo;s
        configuration, so <strong>nothing here is known</strong> about whether
        these hosts are being served. {errorMessage(query.error)}
      </MetaStrip>
    );
  }

  // Nothing is being replaced, so there is nothing to hold space for: a
  // skeleton is sized to a value, and this component has no value most of the
  // time. The table below it is what carries the screen's own `aria-busy`.
  if (query.isPending) return null;

  const status = query.data;
  const when = observed(status.checkedAt);

  if (status.state === "unavailable") {
    return (
      <MetaStrip>
        Cloudgate <strong>could not ask Traefik</strong>{" "}
        what it made of this Application&rsquo;s routing configuration, so
        nothing here says whether these hosts are being served.{" "}
        {status.reason ?? ""}
        {status.reason?.endsWith(".") === false ? "." : ""} {when}
      </MetaStrip>
    );
  }

  if (status.rejections.length === 0) {
    return (
      <MetaStrip>
        Traefik <strong>logged nothing</strong>{" "}
        about this Application&rsquo;s routers when its configuration was last
        written. That is{" "}
        <strong>not a health check</strong> — Traefik says nothing at all about a
        configuration it accepted, so this is what its log said and not proof
        that these hosts are being routed. {when}
      </MetaStrip>
    );
  }

  return (
    <Banner
      icon="alert"
      title="Traefik refused this Application’s routing configuration."
      count={status.rejections.length}
      className="border-bad-line"
    >
      {status.rejections.map((rejection) => (
        <BannerRow
          key={`${rejection.routerName} ${rejection.observedAt}`}
          tone="bad"
          title={`${rejection.domain.host} is not being routed.`}
          description={
            <>
              Traefik dropped the router{" "}
              <span className="font-mono">{rejection.routerName}</span>{" "}
              when it last reloaded, so every request to that host falls through
              to Traefik&rsquo;s catch-all. Traefik reported:{" "}
              {/* Verbatim, and never read for meaning — it is the only thing
                  that names the field, and the backend already cut out any
                  htpasswd entry Cloudgate had just emitted. */}
              <span className="font-mono wrap-anywhere">
                {rejection.message}
              </span>
              . Traefik names the router it dropped and not the link that failed
              to build, so the cause is one of {describeChain(rejection)} — each
              is marked below and on the Advanced tab. Correct one and save
              again. {observed(rejection.observedAt)}
            </>
          }
        />
      ))}
    </Banner>
  );
}

/**
 * "Observed 4 minutes ago." — stated on every state, including the quiet ones.
 *
 * Nothing here is live, and a reader who cannot see how old the answer is will
 * read it as current. The exact stamp is not a `title` here because this is
 * prose rather than a table cell, and prose with a hover-only half is prose half
 * of the readers never get.
 */
function observed(iso: string): string {
  const ago = timeAgo(iso);
  return ago === null ? "" : `Observed ${ago} (${timeExact(iso)}).`;
}
