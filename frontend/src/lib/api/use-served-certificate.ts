import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  domainsApi,
  type ServedCertificate,
} from "@/lib/api/endpoints/domains";
import { keys } from "@/lib/api/keys";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * How long a Let's Encrypt certificate is waited for before it is called not
 * issued (#130). Issuing takes seconds to a minute or two; past this, the
 * HTTP-01 challenge is failing and being retried, usually on an A record
 * that does not point here yet or a port 80 that is not reachable.
 */
export const CERTIFICATE_PATIENCE_MS = 5 * 60_000;

/** How often a certificate still being issued is read again. */
export const CERTIFICATE_POLL_MS = 4_000;

/**
 * Where a Domain's served certificate stands, as the console says it:
 *
 * - `reading`: the first answer is not in.
 * - `issuing`: the host serves a certificate a browser would warn about, and
 *   it has not been {@link CERTIFICATE_PATIENCE_MS} yet.
 * - `issued`: a browser would trust what it serves.
 * - `not-issued`: still not, after that long.
 */
export type ServedCertificateState =
  | { state: "reading" }
  | { state: "issuing" }
  | { state: "issued"; issuer: string | null; notAfter: string | null }
  | { state: "not-issued" };

/** The state, from an answer and whether the wait for it is over. */
export function servedCertificateState(
  served: ServedCertificate | undefined,
  late: boolean,
): ServedCertificateState {
  if (!served) return { state: "reading" };
  if (served.valid) {
    return {
      state: "issued",
      issuer: served.issuer,
      notAfter: served.notAfter,
    };
  }
  return late ? { state: "not-issued" } : { state: "issuing" };
}

/**
 * The certificate `domainId`'s host serves, read again every few seconds
 * while it is `issuing` and stopped as soon as it is not: issued, not issued
 * after {@link CERTIFICATE_PATIENCE_MS}, or the page left. TanStack does not
 * refetch on an interval while the tab is hidden, so a background tab stops
 * too. An issued certificate is read once per page load.
 *
 * `since` is when the wait began, in epoch ms: a Domain's `createdAt` on its
 * own tab, so an old Domain is never "issuing"; the moment the app started
 * in Get started, which waits for the certificate from there. Left out, it
 * is when this hook first ran.
 */
export function useServedCertificate(
  domainId: string | null,
  { enabled = true, since }: { enabled?: boolean; since?: number } = {},
): ServedCertificateState {
  const { organizationId } = useActiveOrganizationId();
  const [mounted] = useState(() => Date.now());
  const start = since ?? mounted;
  const deadline = start + CERTIFICATE_PATIENCE_MS;
  // Whether the wait is over: read off the clock where reading it is allowed
  // (the initializer, and the timer below), never in render.
  const [late, setLate] = useState(() => Date.now() > deadline);
  const query = useQuery({
    queryKey: keys.domains.servedCertificate(organizationId, domainId ?? ""),
    queryFn: () => domainsApi.servedCertificate(domainId!),
    enabled: enabled && organizationId !== null && domainId !== null,
    staleTime: Infinity,
    retry: false,
    refetchInterval: (current) => {
      const state = servedCertificateState(
        current.state.data,
        Date.now() > deadline,
      ).state;
      // `reading` too: the interval is set before the first answer, and an
      // interval of `false` there would never be asked again.
      return state === "issuing" || state === "reading"
        ? CERTIFICATE_POLL_MS
        : false;
    },
  });
  const current = servedCertificateState(query.data, late);
  // An answer that has not changed is no render (TanStack keeps the same
  // object), so the move from `issuing` to `not-issued` is a render of its
  // own, at the deadline.
  const issuing = current.state === "issuing";
  useEffect(() => {
    if (!issuing) return;
    const timer = setTimeout(
      () => setLate(true),
      Math.max(0, deadline - Date.now() + 1),
    );
    return () => clearTimeout(timer);
  }, [issuing, deadline]);
  return current;
}
