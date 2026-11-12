import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { isApiError } from "./api-error";
import { settingsApi, type RuntimeInfo } from "./endpoints/settings";
import { keys } from "./keys";

/**
 * `GET /settings/runtime-info` for one host, and the one distinction every
 * reader of it makes.
 *
 * **Promoted out of `features/server/runtime-info.tsx`**, which is
 * §1.4's promotion rule firing on the condition that file's own docblock wrote
 * down: the hook lived beside the rows because *"all three call sites are
 * inside `features/server/`; it is not a cross-feature hook."* There is now a
 * fourth, on Platform → This instance, so the premise is gone. `lib/api/`
 * rather than `components/console/` because none of what moved renders — §3.5's
 * shelf for the reads a screen every feature reaches for belongs to none of.
 *
 * **What deliberately did not move is the half that renders.** `IngressRow`,
 * `ingressNote` and `declaredMissingNote` are still `features/server/`'s: one
 * feature imports them, so the rule does not fire, and promoting them on the
 * strength of their neighbour moving would put a row hardcoded to Traefik and
 * labelled `Ingress` in the shared index with nothing shared asking for it.
 * `runtime-info.tsx` re-exports the three names below, so no call site — and
 * neither of the two specs that `vi.mock("../runtime-info")` — changed.
 */

/**
 * The inventory for one host. `serverId` is the Server described; `null` is the
 * platform host (ADR-0008).
 *
 * `staleTime` matches the server's own 45s window (`RUNTIME_INFO_CACHE_MS`):
 * refetching inside it re-serves the same cached document with the same
 * `observedAt`, so it would be a round trip that cannot return a new answer.
 * `retry: false` because the interesting failure is the 403, and a role does not
 * change between three attempts — it only makes the refusal slower to read.
 */
export function useRuntimeInfo(serverId: string | null) {
  return useQuery({
    queryKey: keys.instanceRuntimeInfo(serverId),
    queryFn: () => settingsApi.runtimeInfo(serverId),
    staleTime: 45_000,
    retry: false,
  });
}

export type RuntimeInfoQuery = UseQueryResult<RuntimeInfo>;

/**
 * Was this a refusal rather than a failure?
 *
 * The distinction every consumer is built on: `403` means nobody asked the
 * machine anything, so a row keeps its name and loses only its reading, and a
 * whole card keeps its rows rather than becoming an error.
 *
 * **An *unnamed* 403** (H-48). Five things hang off this predicate —
 * `IngressRow`'s "version needs owner or admin", `declaredMissingNote`'s and
 * `ingressNote`'s in `features/server/runtime-info.tsx`, and the paragraph and
 * the `Not read` dash in `features/settings/platform/instance-runtime-card.tsx`
 * — and every one of them says or implies that an owner or an admin could take
 * the reading instead. A **banned** operator's refusal carries the same status,
 * and there is no owner who can move them to a role that works, so all five were
 * said to somebody whose role was never the problem. `isUnnamedRefusal` hands a
 * named refusal back to `errorMessage()` and leaves every other 403 exactly
 * where it was.
 *
 * What each caller does with a named refusal is its own decision and they
 * differ, which is the reason this stayed a predicate rather than becoming a
 * `errorMessage()` call here: the card has room for the ban's sentence and shows
 * it through `SectionFailed`, while a `KVRow` is one cell wide and falls to the
 * same neutral "version not known" it already uses for a 500. Both are honest;
 * only the first is informative, and the second is the most a row can be.
 */
export function isRefusal(query: Pick<RuntimeInfoQuery, "error">) {
  return (
    query.error !== null &&
    isApiError(query.error) &&
    query.error.isUnnamedRefusal
  );
}
