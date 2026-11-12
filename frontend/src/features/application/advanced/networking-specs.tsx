// No `"use client"` — see the note in `lifecycle/application-actions.tsx`. These
// are spec *factories* taking callbacks, so the directive would subject those
// callbacks to the serializable rule; the only importer is `panels/advanced.tsx`,
// which is already the client entry point.

import { z } from "zod";

import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import type {
  Port,
  Protocol,
  PublishMode,
  Redirect,
  Security,
} from "@/lib/api/endpoints/networking";

import { ChainMark } from "../traefik-status/chain-mark";

import type { ResourceSpec } from "./resource-spec";
import { example } from "@/components/console/form-spec";

/**
 * The three per-Application networking tables — published ports, Traefik
 * redirects and basic-auth users — as three `ResourceSpec`s.
 *
 * **These are the three sections `resource-spec.ts` said "would be three more if
 * they had a list route".** They have one now
 * each controller
 * gained `GET /?applicationId=`, so the ids the other four routes always needed
 * are handed out and the Advanced tab's three `UnlistableCard`s become three
 * ordinary tables. One file rather than three, because they share a shape and
 * they shared the gap.
 *
 * Two things about them do **not** become ordinary, and both are on the screen:
 *
 * 1. **A basic-auth password is write-only.** Every `security` route projects the
 *    column away (`stripPassword`), so `Security` has no `password` field to
 *    render. Editing a user therefore *replaces* the password rather than showing
 *    it, and the form says so — a blank field that silently kept the old value
 *    would be the more familiar behaviour and the wrong one here, because this is
 *    the one of the three where being wrong locks people out.
 * 2. **They go live at different times.** A port is read when the Application
 *    is deployed, by the Swarm service spec, so it waits for the next
 *    Deployment. Redirects and basic auth are not: each save regenerates the
 *    Application's Traefik file, and Traefik reloads it within a second —
 *    which is why their remove confirms say so, the way the Domains
 *    tab says it. This file used to claim all three waited.
 *
 * The two that Traefik reads take a `troubled` predicate (H-38/H-62). Traefik
 * drops a whole router when any middleware in its chain fails to build and logs
 * **which router**, never which link — so a rejection names a set of rows, and
 * marking each of them here is what turns "an Application went dark" into "this
 * redirect". Ports do not take one: they are bound on the Server by Swarm and
 * never reach Traefik at all.
 */

/* ── Ports ──────────────────────────────────────────────────────────────── */

const PROTOCOLS = [
  { value: "tcp", label: "TCP" },
  { value: "udp", label: "UDP" },
] as const;

const PUBLISH_MODES = [
  { value: "ingress", label: "Ingress — routed by the Swarm mesh" },
  { value: "host", label: "Host — bound on the node that runs the task" },
] as const;

const portSchema = z.object({
  publishedPort: z
    .number()
    .int("A port is a whole number.")
    .min(1, "A port is between 1 and 65535.")
    .max(65535, "A port is between 1 and 65535."),
  targetPort: z
    .number()
    .int("A port is a whole number.")
    .min(1, "A port is between 1 and 65535.")
    .max(65535, "A port is between 1 and 65535."),
  protocol: z.enum(["tcp", "udp"]),
  publishMode: z.enum(["ingress", "host"]),
});

export type PortValues = z.infer<typeof portSchema>;

export function portsSpec({
  applicationId,
  create,
  update,
  remove,
}: {
  applicationId: string;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (portId: string, input: Record<string, unknown>) => Promise<unknown>;
  remove: (portId: string) => Promise<unknown>;
}): ResourceSpec<Port, PortValues> {
  return {
    noun: "published port",
    plural: "published ports",
    title: "Ports",
    lede: "Ports reachable on the Server itself, without going through Traefik.",
    icon: "net",
    addLabel: "Publish a port",
    emptyTitle: "No port is published",
    emptyBody:
      "Publish a port when something that is not HTTP has to reach this Application directly. For HTTP, a domain on the Domains tab is the usual way in.",
    tableLabel: "Published ports",
    defaultSort: { id: "publishedPort", dir: "asc" },
    getRowId: (row) => row.portId,
    rowName: (row) => `${row.publishedPort}/${row.protocol}`,

    columns: [
      {
        id: "publishedPort",
        head: "On the Server",
        tone: "key",
        compare: (a, b) => a.publishedPort - b.publishedPort,
        cell: (row) => (
          <span className="font-mono text-meta">
            {row.publishedPort}/{row.protocol}
          </span>
        ),
      },
      {
        id: "targetPort",
        head: "In the container",
        tone: "num",
        compare: (a, b) => a.targetPort - b.targetPort,
        cell: (row) => <span className="font-mono">{row.targetPort}</span>,
      },
      {
        id: "publishMode",
        head: "How",
        compare: (a, b) => a.publishMode.localeCompare(b.publishMode),
        cell: (row) => (
          <Chip>{row.publishMode === "host" ? "Host" : "Ingress"}</Chip>
        ),
      },
    ],

    schema: portSchema,
    fields: [
      {
        kind: "number",
        name: "publishedPort",
        label: "Port on the Server",
        min: 1,
        max: 65535,
        placeholder: example("5432"),
        hint: "What clients connect to. It has to be free on every node that could run this Application.",
      },
      {
        kind: "number",
        name: "targetPort",
        label: "Port in the container",
        min: 1,
        max: 65535,
        placeholder: example("5432"),
        hint: "What the process inside is listening on.",
      },
      {
        kind: "select",
        name: "protocol",
        label: "Protocol",
        options: PROTOCOLS,
      },
      {
        kind: "select",
        name: "publishMode",
        label: "How it is published",
        options: PUBLISH_MODES,
        hint: "Ingress publishes the port on every node and load-balances across tasks. Host binds it only on the node running the task, which is what you want when the client needs the real source address.",
      },
    ],

    toDefaults: (row) => ({
      // A create dialog opens on the common case rather than empty: the two
      // ports are the same number far more often than not.
      publishedPort: row?.publishedPort ?? 8080,
      targetPort: row?.targetPort ?? 8080,
      protocol: (row?.protocol ?? "tcp") as Protocol,
      publishMode: (row?.publishMode ?? "ingress") as PublishMode,
    }),

    // What `/ports` asks of each write. Its `PATCH` names
    // `service: ['create']`, not `update`, and the gate asks what the route asks.
    permissions: {
      create: { service: ["create"] },
      update: { service: ["create"] },
      remove: { service: ["delete"] },
    },
    create: (values) => create({ ...values, applicationId }),
    update: (row, values) => update(row.portId, values),
    remove: (row) => remove(row.portId),

    deleteNote: (row) => (
      <>
        Port <strong className="font-medium text-tx">{row.publishedPort}</strong>{" "}
        stops being published on the next Deployment. Anything connecting to it
        directly will stop being able to.
      </>
    ),
  };
}

/* ── Redirects ──────────────────────────────────────────────────────────── */

const redirectSchema = z.object({
  regex: z
    .string()
    .trim()
    .min(1, "A redirect needs a pattern to match.")
    .superRefine((pattern, ctx) => {
      const refusal = re2Refusal(pattern);
      if (refusal) ctx.addIssue({ code: "custom", message: refusal });
    }),
  replacement: z.string().trim().min(1, "A redirect needs somewhere to go."),
  permanent: z.boolean(),
});

export type RedirectValues = z.infer<typeof redirectSchema>;

export function redirectsSpec({
  applicationId,
  troubled,
  create,
  update,
  remove,
}: {
  applicationId: string;
  /** Whether a router Traefik refused named this Redirect's middleware. */
  troubled?: (row: Redirect) => boolean;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (
    redirectId: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  remove: (redirectId: string) => Promise<unknown>;
}): ResourceSpec<Redirect, RedirectValues> {
  return {
    noun: "redirect",
    plural: "redirects",
    title: "Redirects",
    lede: "Traefik sends matching requests somewhere else before this Application sees them.",
    icon: "branch",
    addLabel: "Add a redirect",
    emptyTitle: "Nothing is redirected",
    emptyBody:
      "Add a redirect to rewrite a URL in Traefik before it reaches this Application — a moved path, or a bare domain sent to its www one.",
    defaultSort: { id: "regex", dir: "asc" },
    getRowId: (row) => row.redirectId,
    rowName: (row) => row.regex,

    columns: [
      {
        id: "regex",
        head: "Matches",
        tone: "key",
        compare: (a, b) => a.regex.localeCompare(b.regex),
        cell: (row) => (
          <span className="grid gap-0.5">
            <span className="font-mono text-meta wrap-anywhere">
              {row.regex}
            </span>
            {troubled?.(row) ? <ChainMark /> : null}
          </span>
        ),
      },
      {
        id: "replacement",
        head: "Goes to",
        tone: "wrap",
        cell: (row) => (
          <span className="font-mono text-meta wrap-anywhere text-tx-2">
            {row.replacement}
          </span>
        ),
      },
      {
        id: "permanent",
        head: "Status",
        compare: (a, b) => Number(a.permanent) - Number(b.permanent),
        // The number is the thing an operator is actually checking, and 301 is
        // the one browsers cache for ever — worth naming rather than a tick.
        cell: (row) => <Chip>{row.permanent ? "301" : "302"}</Chip>,
      },
    ],

    schema: redirectSchema,
    fields: [
      {
        kind: "text",
        name: "regex",
        label: "Match this",
        mono: true,
        placeholder: "^https://example\\.com/(.*)",
        hint: "A Go regular expression, matched against the whole URL. Capture groups are available below as ${1}, ${2} and so on.",
      },
      {
        kind: "text",
        name: "replacement",
        label: "Send it here",
        mono: true,
        placeholder: "https://www.example.com/${1}",
        hint: "Where the browser is sent. Use ${1} to keep what the pattern captured.",
      },
      {
        kind: "switch",
        name: "permanent",
        label: "Permanent (301)",
        hint: "A 301 is cached by browsers indefinitely and is hard to take back — leave this off until the redirect is known to be right, and a 302 is sent instead.",
      },
    ],

    toDefaults: (row) => ({
      regex: row?.regex ?? "",
      replacement: row?.replacement ?? "",
      // Off by default, for the reason the hint gives.
      permanent: row?.permanent ?? false,
    }),

    // What `/redirects` asks of each write. Its `PATCH` names
    // `service: ['create']`, not `update`, and the gate asks what the route asks.
    permissions: {
      create: { service: ["create"] },
      update: { service: ["create"] },
      remove: { service: ["delete"] },
    },
    create: (values) => create({ ...values, applicationId }),
    update: (row, values) => update(row.redirectId, values),
    remove: (row) => remove(row.redirectId),

    deleteNote: (row) => (
      <>
        Requests matching{" "}
        <strong className="font-medium text-tx">{row.regex}</strong>{" "}
        reach this Application normally again straight away: Traefik&rsquo;s
        configuration is rewritten as this dialog closes, and it reloads within
        a second. No Deployment is needed.{" "}
        {row.permanent
          ? "A browser that already followed the 301 has it cached and will keep redirecting until that cache expires — which this cannot clear."
          : "Nothing is cached, because it was a 302."}
      </>
    ),
  };
}

/* ── Basic authentication ───────────────────────────────────────────────── */

const securitySchema = z.object({
  username: z.string().trim().min(1, "A basic-auth user needs a username."),
  password: z.string().min(1, "A basic-auth user needs a password."),
});

export type SecurityValues = z.infer<typeof securitySchema>;

export function securitySpec({
  applicationId,
  troubled,
  create,
  update,
  remove,
}: {
  applicationId: string;
  /** Whether a router Traefik refused named the basic-auth middleware. */
  troubled?: (row: Security) => boolean;
  create: (input: Record<string, unknown>) => Promise<unknown>;
  update: (
    securityId: string,
    input: Record<string, unknown>,
  ) => Promise<unknown>;
  remove: (securityId: string) => Promise<unknown>;
}): ResourceSpec<Security, SecurityValues> {
  return {
    noun: "basic-auth user",
    plural: "basic-auth users",
    title: "Basic authentication",
    lede: "Traefik asks for one of these before it lets a request through.",
    icon: "lock",
    addLabel: "Add a user",
    emptyTitle: "Anyone can reach this Application",
    // An empty table here is a real statement now that the list is real, so it
    // makes it plainly: this is the one of the three where saying nothing would
    // be read as "protected".
    emptyBody:
      "Add a user to make Traefik ask for a password. Until then nobody is asked: right for something public, wrong for a staging copy.",
    tableLabel: "Basic-auth users",
    defaultSort: { id: "username", dir: "asc" },
    getRowId: (row) => row.securityId,
    rowName: (row) => row.username,

    columns: [
      {
        id: "username",
        head: "Username",
        tone: "key",
        compare: (a, b) => a.username.localeCompare(b.username),
        cell: (row) => (
          <span className="grid gap-0.5">
            <span className="font-mono text-meta">{row.username}</span>
            {troubled?.(row) ? <ChainMark /> : null}
          </span>
        ),
      },
      {
        id: "password",
        head: "Password",
        // Not a blank cell and not asterisks: both read as "we could show this".
        // Cloudgate genuinely does not have it — every route projects it away —
        // and the column says which of the two it is.
        cell: () => <Dash word="Never shown" />,
      },
    ],

    schema: securitySchema,
    fields: [
      {
        kind: "text",
        name: "username",
        label: "Username",
        mono: true,
        placeholder: example("preview"),
      },
      {
        kind: "password",
        name: "password",
        label: "Password",
        autoComplete: "new-password",
        hint: "Cloudgate never sends a saved basic-auth password back to the browser, so editing a user replaces this rather than revealing it. Whatever you type here becomes the new password.",
      },
    ],

    toDefaults: (row) => ({
      username: row?.username ?? "",
      // Always empty, even when editing: there is nothing to prefill it with.
      password: "",
    }),

    // What `/security` asks of each write: `service: ['create']` for
    // all three, its `DELETE` included — the gate asks what the route asks.
    permissions: {
      create: { service: ["create"] },
      update: { service: ["create"] },
      remove: { service: ["create"] },
    },
    create: (values) => create({ ...values, applicationId }),
    update: (row, values) => update(row.securityId, values),
    remove: (row) => remove(row.securityId),

    deleteNote: (row) => (
      <>
        <strong className="font-medium text-tx">{row.username}</strong>{" "}
        stops being able to sign in straight away: Traefik&rsquo;s configuration
        is rewritten as this dialog closes, and it reloads within a second. No
        Deployment is needed.{" "}
        <strong className="font-medium text-tx">
          If this was the last user, the Application becomes reachable by anyone.
        </strong>
      </>
    ),
  };
}

/**
 * The Go (RE2) constructs a redirect pattern cannot use, as the refusal names
 * them. Order matters: `(?<=` and `(?<!` before anything shorter.
 */
const RE2_REFUSED: readonly (readonly [string, string])[] = [
  ["(?<=", "a lookbehind (?<=…)"],
  ["(?<!", "a negative lookbehind (?<!…)"],
  ["(?=", "a lookahead (?=…)"],
  ["(?!", "a negative lookahead (?!…)"],
];

/**
 * Why Traefik would refuse this pattern, or `null` when this check sees no
 * reason to.
 *
 * Traefik compiles a redirect's `regex` with Go's `regexp`, which is RE2, and a
 * pattern it cannot compile fails the middleware — so every router naming it
 * is dropped and every domain of the Application stops being routed, for one
 * save. This used to be `new RegExp`, which is the check
 * `redirectRuleSchema`'s record in `redirect.dto.ts` rejects by name:
 * ECMAScript and RE2 disagree in both directions, and live it refused `(?i)` and
 * `(?P<name>…)` while passing `(?=…)` (U-74). What that record says a real
 * check would need is "an RE2 parser on this side of the wire"; this is the
 * smaller thing the ticket offered beside it, a Go-dialect syntax pass, and it
 * does not replace the record's answer:
 *
 * - It **accepts** everything V8 wrongly refused, because it never compiles.
 * - It **refuses** the constructs Perl and ECMAScript have and RE2 leaves out
 *   on purpose — lookaround and backreferences — when they are not escaped and
 *   not inside a character class, and names the one it found.
 *
 * **It is not complete, and does not claim to be.** It does not catch an
 * unbalanced group or class, an atomic group `(?>…)`, a possessive quantifier,
 * `\k<name>`, a Unicode class Go does not know, or a repeat count over 1000 —
 * Traefik is the authority on all of those, and a pattern it refuses is
 * reported on the Domains tab and marked on this list. Rejected: a full
 * RE2 parser here, which is a dependency decision and the record's, not this
 * ticket's.
 */
function re2Refusal(pattern: string): string | null {
  let inClass = false;
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === "\\") {
      const next = pattern[index + 1];
      // Go reads `\1`–`\7` followed by an octal digit as a character code
      // (`\12` is a newline) and only a lone one as the backreference it
      // refuses; `\8` and `\9` are never octal. Measured with Go 1.24's
      // `regexp.Compile`: `\12` and `\123` compile, `\1`, `\78` and `\8` do not.
      const after = pattern[index + 2];
      const octal = after !== undefined && after >= "0" && after <= "7";
      if (
        !inClass &&
        next !== undefined &&
        ((next >= "1" && next <= "7" && !octal) || next === "8" || next === "9")
      ) {
        return refused(`a backreference (\\${next})`);
      }
      index++; // whatever is escaped is a literal, including `(` and `[`
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") {
      inClass = true;
      // `[]…]` and `[^]…]`: a `]` first in a class is a member, not its end.
      if (pattern[index + 1] === "^") index++;
      if (pattern[index + 1] === "]") index++;
      continue;
    }
    for (const [token, name] of RE2_REFUSED) {
      if (pattern.startsWith(token, index)) return refused(name);
    }
  }
  return null;
}

function refused(construct: string): string {
  return `Traefik compiles this as a Go regular expression, which does not support ${construct} — saved, it would stop every domain of this Application being routed.`;
}
