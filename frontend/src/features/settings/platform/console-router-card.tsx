import { Banner, BannerRow } from "@/components/console/banner";
import { Card } from "@/components/console/card";
import { MetaStrip } from "@/components/console/meta-strip";
import { ApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import type { ConsoleOriginTrust } from "@/lib/api/endpoints/settings";
import type { TraefikConsoleRejection } from "@/lib/api/endpoints/traefik";
import { timeAgo, timeExact } from "@/lib/format/time";

import { ConsoleOriginRemedy, LiveScreensCaveat } from "./console-origin-remedy";
import { useConsoleRouterStatus } from "./use-platform";

/**
 * What Traefik made of the routers that put **this console** on a hostname
 * (H-61).
 *
 * **Why this card exists at all.** H-38 reports a refused router against the
 * Cloudgate rows in its chain — a Domain, a Redirect, a basic-auth user — and
 * every one of those belongs to an Application. The two files the file provider
 * watches that no Application owns are `dynamic/cloudgate.yml`, written by the
 * **Console domain** form above, and `dynamic/middlewares.yml`, written by the
 * **Traefik middlewares configuration** on the Traefik tab. A rejection in
 * either was reported nowhere, and it is the one failure an operator cannot
 * diagnose from the console, because the console is what stops being served.
 *
 * **So why put it on a screen inside the console.** Because losing the router
 * does not lose the console: Traefik serves it on a *hostname*, and
 * `deploy/install.sh` also leaves it listening on `CONSOLE_PORT` on the machine
 * itself. An operator whose `console.example.com` has just gone dark reaches
 * `http://<host>:3000` and lands here — beside the form that wrote the router —
 * which is the first place they would look and the only place that can say what
 * Traefik actually refused. The backend's `logger.error` stays for the case
 * where neither address answers.
 *
 * The three states mean exactly what they mean on an Application's Domains tab,
 * and the two quiet ones are quiet in different ways: **`checked` with nothing
 * is not a tick** — Traefik logs nothing at all for a configuration it accepted
 * — and **`unavailable` is not health either**. Nothing here is live: the check
 * runs when something writes a Traefik configuration on this host, and the
 * Console domain form above and the two raw-YAML editors on the
 * Traefik tab are among those writers rather than only an unrelated
 * Application's regeneration.
 *
 * **Every state dates itself by when Cloudgate *looked***, which is what
 * `checkedAt` carries and is not the same fact as when the file was written.
 * The sentences below used to promise the second and show the first, so a card
 * reporting an hour-old observation of another write read as a report on the
 * save just made.
 *
 * **Served is not usable, so the card also says whether anybody can sign in**
 * Traefik can
 * accept every router and Let's Encrypt can issue the certificate while every
 * sign-in on the domain is refused `403 INVALID_ORIGIN`, because the backend
 * does not trust the origin — which is the state a stock install lands in.
 * `consoleOrigin` is the backend's answer, taken against the same lists the
 * refusal is, and it is not dated like the rest of the card because it is read
 * live on every load of the settings row. It is said above Traefik's verdict
 * and independently of it: a routing report that reads clean is exactly what
 * made this trap look like success.
 */
export function ConsoleRouterCard({
  consoleOrigin,
}: {
  consoleOrigin: ConsoleOriginTrust | null;
}) {
  const status = useConsoleRouterStatus();

  // A member who is not an operator of this instance is answered 403, and that
  // is not a fault to report: the two files are not theirs to read and the rest
  // of this screen already hides what they may not have. Any other refusal is
  // said out loud — silence is the thing this card exists to end.
  if (status.error instanceof ApiError && status.error.status === 403) {
    return null;
  }
  if (status.isPending) return null;

  return (
    <Card>
      <Card.Header
        title="Console routing"
        sub="What Traefik made of the routers that serve this console on its domain."
        headingLevel={2}
      />
      {consoleOrigin && !consoleOrigin.trusted ? (
        <SignInRefused origin={consoleOrigin.origin} />
      ) : null}
      {status.error ? (
        <Card.Body>
          <p className="text-body text-tx-2">
            Cloudgate could not read what Traefik made of the console&rsquo;s own
            routers, so <strong>nothing here is known</strong> about whether this
            console is being served on its domain. {errorMessage(status.error)}
          </p>
        </Card.Body>
      ) : status.data.state === "unavailable" ? (
        <MetaStrip>
          Cloudgate <strong>could not ask Traefik</strong>{" "}
          about the console&rsquo;s own routers, so nothing here says whether
          this console is being served on its domain. {status.data.reason}.{" "}
          {observed(status.data.checkedAt)}
        </MetaStrip>
      ) : status.data.rejections.length === 0 ? (
        <MetaStrip>
          Traefik <strong>logged nothing</strong>{" "}
          about the console&rsquo;s own routers when Cloudgate last read its log.
          That is <strong>not a health check</strong> — Traefik says nothing at
          all about a configuration it accepted, so this is what its log said and
          not proof that the console is being served on its domain.{" "}
          {observed(status.data.checkedAt)}
        </MetaStrip>
      ) : (
        <Banner
          icon="alert"
          title="Traefik refused a router that serves this console."
          count={status.data.rejections.length}
          className="border-0 border-t border-bad-line"
        >
          {status.data.rejections.map((rejection) => (
            <BannerRow
              key={`${rejection.routerName} ${rejection.observedAt}`}
              tone="bad"
              title="This console is not being served on its domain."
              description={<Refusal rejection={rejection} />}
            />
          ))}
        </Banner>
      )}
    </Card>
  );
}

/** The console domain is served, and nobody can sign in on it. */
function SignInRefused({ origin }: { origin: string }) {
  const mono = <span className="font-mono wrap-anywhere">{origin}</span>;
  return (
    <Card.Body className="border-b border-line">
      <div className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx">
        <p>
          <strong className="font-semibold">
            Sign-in on this console&rsquo;s domain will be refused.
          </strong>{" "}
          The backend does not trust {mono}, so every sign-in there is answered{" "}
          <span className="font-mono">403 INVALID_ORIGIN</span> however the
          routers below fare. <ConsoleOriginRemedy origin={mono} />
        </p>
        <p className="mt-1.5 text-tx-2">
          <LiveScreensCaveat />
        </p>
      </div>
    </Card.Body>
  );
}

/** One refused console router, and where to go and correct it. */
function Refusal({ rejection }: { rejection: TraefikConsoleRejection }) {
  return (
    <>
      Traefik dropped the router{" "}
      <span className="font-mono">{rejection.routerName}</span>{" "}
      when it last reloaded, so every request to the console&rsquo;s host falls
      through to Traefik&rsquo;s catch-all. This console is still reachable on this
      machine&rsquo;s own address and port, which is how you are reading it.
      Traefik reported:{" "}
      <span className="font-mono wrap-anywhere">{rejection.message}</span>.{" "}
      {rejection.source === "console-domain"
        ? "It was written by the Console domain settings on this screen."
        : "It was written by the Traefik middlewares configuration on the Traefik tab."}
      {rejection.middlewares.length > 0 ? (
        <>
          {" "}
          Traefik names the router it dropped and not the link that failed to
          build, so the cause is one of the middlewares it lists:{" "}
          <span className="font-mono wrap-anywhere">
            {rejection.middlewares.join(", ")}
          </span>
          .
        </>
      ) : null}{" "}
      {observed(rejection.observedAt)}
    </>
  );
}

/** "Observed 4 minutes ago." — stated on every state, because none is live. */
function observed(iso: string): string {
  const ago = timeAgo(iso);
  return ago === null ? "" : `Observed ${ago} (${timeExact(iso)}).`;
}
