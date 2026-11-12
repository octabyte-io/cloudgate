import Link from "next/link";

import { useLicenseStatus } from "@/features/enterprise/use-license";

/**
 * How to get the backend to trust the console domain's origin — the move the
 * Console domain card names before a save and the Console routing card names
 * after one.
 *
 * **Two levers, and which one to lead with depends on the licence.** The
 * backend merges `TRUSTED_ORIGINS` with the owners' Trusted origins list on
 * every request, so an origin added on that card is trusted at once, while the
 * env key needs a restart. The card sits behind an enterprise licence, so an
 * unlicensed instance is told plainly that its only route is the env file.
 * While the licence read is in flight or has failed, `licensed` is `undefined`,
 * which is not a fact about the instance — both routes are named then, the
 * same answer the pre-auth sign-in screen gives (`lib/auth/auth-error.ts`).
 *
 * The licence read is this Organization's, the one every other lock on the
 * console asks; `ConcurrentBuildsCard` records the same caveat.
 */
export function ConsoleOriginRemedy({
  origin,
}: {
  /** The origin itself when it is known, or words for it when it is not. */
  origin: React.ReactNode;
}) {
  const licensed = useLicenseStatus().data?.licensed;
  const envRoute = (
    <>
      add {origin} to{" "}
      <span className="font-mono">TRUSTED_ORIGINS</span>{" "}
      in the backend&rsquo;s
      environment (<span className="font-mono wrap-anywhere">/etc/default/cloudgate-backend</span>{" "}
      on an install) and restart the backend
    </>
  );
  const ssoScreen = (
    <Link
      href="/settings/sso"
      className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
    >
      Settings → Single sign-on
    </Link>
  );

  if (licensed === true) {
    return (
      <>
        Trust {origin} under Trusted origins on {ssoScreen}, which takes effect
        at once with no restart.
      </>
    );
  }
  if (licensed === false) {
    return (
      <>
        Trusted origins on {ssoScreen}, which would trust {origin} with no
        restart, needs an enterprise license and this Organization has none. So{" "}
        {envRoute}.
      </>
    );
  }
  return (
    <>
      Trust {origin} under Trusted origins on {ssoScreen}, which takes effect
      at once and needs an enterprise license. Without a license, {envRoute}.
    </>
  );
}

/**
 * The second half of the constraint, and the one no allowlist cures:
 * `NEXT_PUBLIC_API_URL` is baked into the console at build time, and the live
 * screens dial it directly, carrying the session by cookie alone — so they need
 * the API on the same hostname as the console (`docs/deploy.md` §3). The
 * routers the Console domain card writes send that hostname to the console and
 * nothing else, which is why this says the live screens stay blank there on a
 * stock install rather than implying a rebuild alone fixes it. The installer's
 * own comment is the reason Cloudgate never trusts the console domain by
 * itself: doing so signs an operator in on an address whose live screens are
 * dead, with nothing on screen saying why.
 */
export function LiveScreensCaveat() {
  return (
    <>
      Trusting it makes sign-in and the ordinary screens work there. The live
      ones — Deployment logs, container logs, terminals, stats — dial{" "}
      <span className="font-mono">NEXT_PUBLIC_API_URL</span>, which is baked in
      when the console is built, so they also need a rebuild naming an API
      address on this same hostname; a restart does not change it. The routers
      saved here send the hostname to the console only, so on a stock install
      those screens stay blank there (
      <span className="font-mono">docs/deploy.md</span> §3 and §7).
    </>
  );
}
