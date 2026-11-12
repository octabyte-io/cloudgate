import Link from "next/link";

import { Icon } from "@/lib/design/icons";
import type { DomainValidation } from "@/lib/api/endpoints/domains";
import { settingsHref } from "@/lib/settings/sections";

/** The one link this panel makes, and it makes it three times. */
function InstanceLink() {
  return (
    <Link
      href={settingsHref("instance")}
      className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
    >
      Settings → Instance
    </Link>
  );
}

/**
 * Exactly which DNS record to create, and what the resolver currently sees.
 *
 * **A `*.sslip.io` host has no record to create, and saying otherwise sent
 * operators after one.** sslip.io answers from the name itself — it
 * resolves the address written into it — so the three fields below described an
 * `A` record in the zone `sslip.io` that nobody but sslip.io can create. That is
 * the host "Generate one for me" hands over, so it was the *common* case of this
 * panel rather than an edge of it. The record half is kept for every other host,
 * unchanged.
 *
 * **The record is derived, not described.** Given `api.example.com` and the
 * Server's address, there is one right answer — an `A` record whose name is the
 * subdomain and whose value is that address — so the helper prints the three
 * fields a DNS provider's form asks for rather than a sentence about them. An apex
 * host (`example.com` with no subdomain) gets `@`, which is what every provider
 * uses for the zone itself.
 *
 * **`host` is a host the rule has already accepted, not the field's text.** The
 * three fields are an instruction to go and create something, so a record
 * derived from `x11_app.example.com` — refused by the schema a line above it, in
 * the same dialog — told an operator to create a record for a name the product
 * will never route (X11-6). The gate is `domain-host-field.tsx`'s, because the
 * caller is what holds the field; `isHostname` is the rule both of them apply.
 *
 * **A CDN in front of the origin is valid, and says so.** `cdn.service.ts` returns
 * `isValid: true` *with* a warning when it recognises Cloudflare or friends,
 * because the proxy's address is the honest answer to "what does this resolve to"
 * and Cloudgate cannot see past it. A screen that read the presence of `error` as
 * failure would tell someone their working setup is broken — so this reads
 * `isValid` and treats the message as a note.
 */
export function DnsHelper({
  host,
  serverIp,
  result,
  pending,
  noun = "Application",
}: {
  host: string;
  /**
   * Where it should point, and `null` when Cloudgate does not know: no Server
   * row *and* nothing recorded in Settings → Instance. The panel says which of
   * the two it is rather than printing a Value nobody can act on.
   */
  serverIp: string | null;
  result: DomainValidation | null;
  pending?: boolean;
  /** What is being pointed at, for the one sentence that names it (F12: "stack"). */
  noun?: string;
}) {
  const record = recordFor(host);
  const sslip = isSslip(host);
  const written = sslip ? addressInSslipName(host) : null;

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-panel-2 px-3.5 py-3">
      {sslip ? (
        <>
          <p className="text-meta font-medium text-tx">
            There is no record to create
          </p>
          {written ? (
            <p className="text-meta text-tx-2">
              sslip.io answers from the name itself, so this host resolves to{" "}
              <span className="font-mono tracking-mono wrap-anywhere">
                {written}
              </span>{" "}
              with no DNS provider involved.
            </p>
          ) : (
            <p className="text-meta text-tx-2">
              sslip.io answers from the name itself, and this name carries no
              address — so it resolves to nothing.{" "}
              {serverIp === null ? (
                <>
                  Record this host&rsquo;s public address in <InstanceLink /> and
                  generate a host again.
                </>
              ) : (
                <>
                  Generate one for me writes this {noun}&rsquo;s address,{" "}
                  <span className="font-mono tracking-mono wrap-anywhere">
                    {serverIp}
                  </span>
                  , into the name.
                </>
              )}
            </p>
          )}
        </>
      ) : (
        <>
          <p className="text-meta font-medium text-tx">
            The record to create at your DNS provider
          </p>

          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-meta">
            <dt className="text-tx-2">Type</dt>
            <dd className="font-mono tracking-mono text-tx">A</dd>
            <dt className="text-tx-2">Name</dt>
            <dd className="font-mono tracking-mono wrap-anywhere text-tx">
              {record.name}
            </dd>
            <dt className="text-tx-2">Value</dt>
            <dd className="font-mono tracking-mono wrap-anywhere text-tx">
              {serverIp ?? "this machine's public address"}
            </dd>
          </dl>

          {record.name === "@" ? (
            <p className="text-meta text-tx-2">
              <span className="font-mono">@</span> means the zone itself — the
              name your provider shows as blank or as the domain.
            </p>
          ) : (
            <p className="text-meta text-tx-2">
              Name is the part in front of your zone, and this takes your zone to
              be the last two labels —{" "}
              <span className="font-mono tracking-mono">{record.zone}</span>. A
              longer zone, like <span className="font-mono">example.co.uk</span>,
              means a shorter Name: take off the labels your zone already covers,
              or use <span className="font-mono">@</span> if that leaves none.
            </p>
          )}

          {serverIp === null ? (
            <p className="text-meta text-tx-2">
              {/* `{" "}` because the text node after an expression wraps to the next
                  line, and a JSXText containing a newline loses its leading space —
                  "This stackruns on…" is what that looks like. Three phases have now
                  paid for this rule; the fourth is this one. */}
              This {noun}{" "}
              runs on Cloudgate&rsquo;s own host, which has no Server row, so
              point the record at whatever address reaches this machine.
              Recording it in <InstanceLink /> puts it in Value above and lets
              Check DNS compare the two.
            </p>
          ) : null}
        </>
      )}

      {pending ? (
        <p className="flex items-center gap-2 text-meta text-tx-2">
          <Icon name="clock" size={14} className="text-tx-3" />
          Resolving {host}…
        </p>
      ) : result ? (
        <Verdict host={host} serverIp={serverIp} result={result} />
      ) : null}
    </div>
  );
}

function Verdict({
  host,
  serverIp,
  result,
}: {
  host: string;
  serverIp: string | null;
  result: DomainValidation;
}) {
  // An answer with nothing to compare against is not an "ok": with no expected
  // address the console sends no `expectedIp`, and `cdn.service.ts` answers
  // `isValid` for any host that resolves *at all* — so `dns.google` came back in
  // the green tone under a promise about a certificate. It is a real
  // answer about DNS and a missing answer about this machine, which is the warn
  // tone's job rather than either of the other two.
  const tone = result.isValid
    ? result.cdnProvider || serverIp === null
      ? "warn"
      : "ok"
    : "bad";

  return (
    <div
      className={
        tone === "ok"
          ? "flex items-start gap-2 rounded-md border border-ok-line bg-ok-tint px-2.75 py-2 text-meta text-tx"
          : tone === "warn"
            ? "flex items-start gap-2 rounded-md border border-warn-line bg-warn-tint px-2.75 py-2 text-meta text-tx"
            : "flex items-start gap-2 rounded-md border border-bad-line bg-bad-tint px-2.75 py-2 text-meta text-tx"
      }
    >
      <Icon
        name={tone === "ok" ? "check" : tone === "warn" ? "info" : "alert"}
        size={14}
        className={
          tone === "ok" ? "mt-0.5 text-ok" : tone === "warn" ? "mt-0.5 text-warn" : "mt-0.5 text-bad"
        }
      />
      <div className="min-w-0">
        <p className="font-medium">
          {result.cdnProvider
            ? `${host} is behind ${result.cdnProvider}.`
            : result.isValid
              ? serverIp
                ? `${host} points here.`
                : `${host} resolves.`
              : `${host} does not point here yet.`}
        </p>
        {result.resolvedIp ? (
          <p className="mt-0.5">
            It resolves to{" "}
            <span className="font-mono tracking-mono wrap-anywhere">
              {result.resolvedIp}
            </span>
            .
          </p>
        ) : null}
        {result.cdnProvider ? (
          <p className="mt-0.5 text-tx-2">
            Cloudgate cannot see past the proxy to check the origin, so this is as
            far as the check goes. Make sure the CDN&rsquo;s own origin is the
            address above.
          </p>
        ) : result.error && !result.isValid ? (
          <p className="mt-0.5 text-tx-2">
            DNS changes can take a while to spread. Create or correct the record
            above and check again.
          </p>
        ) : null}
        {result.isValid && !result.cdnProvider ? (
          serverIp === null ? (
            <p className="mt-0.5 text-tx-2">
              Cloudgate has no address recorded for its own host, so this says
              the name resolves and not that it reaches this machine. Record it
              in <InstanceLink /> and the check can compare the two.
            </p>
          ) : (
            <p className="mt-0.5 text-tx-2">
              A certificate can be issued once the record is in place, which it
              is.
            </p>
          )
        ) : null}
      </div>
    </div>
  );
}

/**
 * The record's name, as a DNS provider's form wants it, and the zone that
 * answer assumed.
 *
 * Two labels is the zone itself (`example.com` → `@`); anything longer is a
 * subdomain, and the provider's form takes only the part in front of the zone
 * (`api.example.com` → `api`, `a.b.example.com` → `a.b`).
 *
 * **Where the zone cut falls is an assumption, and for a public suffix it is
 * wrong rather than vague** — `api.example.co.uk` prints `api.example` where
 * that zone's form wants `api`, and the operator finds out when the record does
 * not resolve. So `zone` exists to be *said*: the note under the table names the
 * last two labels it took the zone to be, on every host, and tells a `.co.uk`
 * owner that theirs is longer and the Name correspondingly shorter (H-145).
 *
 * **Copy, deliberately, and not a public-suffix-aware cut.** Computing the cut
 * correctly needs the public suffix list, which is a large runtime input to
 * carry for a hint the operator retypes into somebody else's form — and this
 * panel's job is to save a derivation, not to be authoritative. Silence was the
 * one option ruled out.
 *
 * Two notes, one rendered: the `@` case explains `@`, every other case names the
 * assumed zone, and the ternary between them is what keeps "the panel always
 * says what it assumed" true rather than nearly true. An earlier docblock here
 * credited that disclosure to "the chip beside it" — `ZoneChip`, exported from
 * this file and mounted by nothing, deleted in X11 — so for as long as that
 * sentence stood, the mitigation it described was one no operator ever saw.
 */
function recordFor(host: string): { name: string; zone: string } {
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return { name: "@", zone: host };
  return {
    name: labels.slice(0, -2).join("."),
    zone: labels.slice(-2).join("."),
  };
}

/** Whether the answer comes from sslip.io rather than from a record. */
function isSslip(host: string): boolean {
  return /\.sslip\.io$/i.test(host.trim());
}

/**
 * The address written into an sslip.io name, as sslip.io reads it, or `null`
 * when the name carries none.
 *
 * sslip.io takes the last IPv4 quad in the name, dashed or dotted, and answers
 * with it — `blog-4f2a1c-203-0-113-10.sslip.io` and `blog.203.0.113.10.sslip.io`
 * both resolve to `203.0.113.10`. A name with no quad in it, which is what
 * Generate used to hand over, resolves to nothing at all, and that is the
 * distinction this draws: the panel can then say which of the two this is.
 *
 * Reading an address *out of* a name is the opposite of the check
 * `DomainsService.generateDomain` makes before writing one in, which asks only
 * whether a recorded address is a literal at all — hence two names rather than
 * one shared across the two packages.
 *
 * IPv6 is deliberately not read. sslip.io carries those too
 * (`2001-db8--1.sslip.io`), but `generateDomain` dashes its colons into a form
 * that cannot be told from a label by shape, and a wrong address printed as
 * fact is worse than the sentence above it that is true either way.
 */
function addressInSslipName(host: string): string | null {
  const name = host.trim().replace(/\.sslip\.io$/i, "");
  const quad = /(?:^|[-.])((?:\d{1,3}[-.]){3}\d{1,3})$/.exec(name);
  if (!quad) return null;
  const parts = quad[1].split(/[-.]/);
  if (parts.some((part) => Number(part) > 255)) return null;
  return parts.join(".");
}
