import { KVRow } from "@/components/console/kv-list";
import { Skeleton } from "@/components/console/skeleton";
import {
  isRefusal,
  useRuntimeInfo,
  type RuntimeInfoQuery,
} from "@/lib/api/use-runtime-info";

/**
 * The version a host is **actually** running, put back on the rows once emptied.
 *
 * Three hardcoded `Traefik v3.5.0` literals were deleted rather than bumped:
 * the pin moves, `TRAEFIK_VERSION` can be overridden per install, and a console
 * that writes a version down is wrong the same way again on the next bump. That
 * left the rows saying `Traefik` and nothing else, and three comments saying a
 * version belongs back only once something could *observe* one. That route
 * shipped; this module is what reads it.
 *
 * **Declared is rendered beside observed, because the gap is the point.** An
 * install pinning `3.6.7` while the container still runs `3.5.0` is exactly the
 * condition the literals were a symptom of, and the endpoint reports `drift:
 * true` for it. Showing only the observed number would hide it; showing only
 * the declared one is the literal all over again, fetched.
 *
 * Two failure modes shape every branch below, and reading either one wrong is
 * worse than the blank row was:
 *
 * 1. **A 403 is a role, not a reading.** The route is owner/admin gated and
 *    refuses before it probes anything, so a plain member must see the row
 *    *degrade* — the ingress named, its version absent — rather than an error
 *    where a value used to be. `HealthCard` and `RequestsChart` already draw
 *    this distinction on this same 403; the branch is theirs.
 * 2. **A null `observed` is normal.** Docker stopped, or a remote Server that
 *    could not be reached, comes back 200 with `observed: null` and a `reason`.
 *    That reads "not known" and nothing on the screen goes red, because nothing
 *    is known to be wrong.
 */

/**
 * The read, and the refusal test, **moved to `lib/api/use-runtime-info.ts`**
 * and re-exported here.
 *
 * The paragraph that used to sit on `useRuntimeInfo` said it lived here because
 * *"all three call sites are inside `features/server/`; it is not a
 * cross-feature hook"* — a premise with an expiry date on it, and it
 * expired: Platform → This instance now reads the same document for the platform
 * host. §1.4's promotion rule is mechanical about what happens next, and §3.5
 * names the shelf: a hook a second feature imports does not render, so it goes
 * to `lib/api/`.
 *
 * **Re-exported rather than repointed**, the way `resource-spec.ts` re-exports
 * what F11 moved out of it: three call sites in this feature and the two specs
 * that `vi.mock("../runtime-info")` keep working unchanged, and the rows below —
 * which are still only this feature's — keep reading as one module.
 */
export { isRefusal, useRuntimeInfo, type RuntimeInfoQuery };

/**
 * The `Ingress` row on a Server's Infrastructure and Docker tabs.
 *
 * Both tabs carry the identical row against the identical five states, so it is
 * one component rather than the same state machine written twice — the second
 * copy is where the two would start disagreeing about what a null means.
 *
 * The value is the two-part span the Swarm services list already uses: what the
 * row *is* in primary text, and the reading about it one step quieter beside it.
 */
export function IngressRow({ query }: { query: RuntimeInfoQuery }) {
  return <KVRow label="Ingress" {...ingressValue(query)} />;
}

/** The row's props for one state — the value node, and `aria-busy` while pending. */
function ingressValue(query: RuntimeInfoQuery): {
  value: React.ReactNode;
  "aria-busy"?: "true";
} {
  // Terminal-state order: error before pending before the value. A refusal is
  // its own branch ahead of the generic error, because it is not one.
  if (isRefusal(query)) {
    return { value: <Ingress note="version needs owner or admin" /> };
  }
  if (query.error) {
    return { value: <Ingress note="version not known" /> };
  }
  if (query.isPending) {
    return {
      value: <Skeleton className="ml-auto w-20" />,
      "aria-busy": "true",
    };
  }

  const traefik = query.data?.traefik;
  if (!traefik) return { value: <Ingress note="version not known" /> };

  if (traefik.observed === null) {
    // The host answered nothing, or there is no container. Still a 200, still
    // not an error — the declared pin is the only half that is known.
    return {
      value: (
        <Ingress
          note={
            traefik.declared
              ? `version not known — ${traefik.declared} declared`
              : "version not known"
          }
        />
      ),
    };
  }

  return {
    value: (
      <Ingress
        version={traefik.observed}
        // Only when they disagree. Printing "declared 3.6.7" beside an observed
        // 3.6.7 is noise on every healthy install, and the row would stop being
        // scannable for the one install where it matters.
        note={traefik.drift ? `declared ${traefik.declared}` : undefined}
      />
    ),
  };
}

function Ingress({ version, note }: { version?: string; note?: string }) {
  return (
    <span className="flex flex-wrap items-baseline justify-end gap-x-2">
      <span>
        Traefik{version ? <span className="num"> {version}</span> : null}
      </span>
      {note ? <span className="text-meta text-tx-3">{note}</span> : null}
    </span>
  );
}

/**
 * Why a version is not on screen — or null when it is on its way, or here.
 *
 * The fleet card needs this apart from `IngressRow` because it renders the
 * **declared** side only, for two different products, and a declared value is
 * missing for exactly the two reasons a row cannot say anything at all: the role
 * could not ask, or the request failed. A null `observed` never reaches here.
 */
export function declaredMissingNote(query: RuntimeInfoQuery): string | null {
  if (isRefusal(query)) return "version needs owner or admin";
  if (query.error) return "version not known";
  return null;
}

/**
 * The sentence under the list the row now earns.
 *
 * Two of them, because the refusal changes what the row *is* rather than only
 * what it says: on a 403 nothing was measured, and a member reading "where it
 * differs, both are shown" beside a row with no number would reasonably conclude
 * the reading failed.
 */
export function ingressNote(query: RuntimeInfoQuery) {
  return isRefusal(query)
    ? "Only an owner or an admin can read the running versions, so this row names the ingress and not its version. Nothing is known to be wrong — the reading was not taken."
    : "The Traefik version is read off the running container. Where it differs from the one this Cloudgate pins, both are shown.";
}
