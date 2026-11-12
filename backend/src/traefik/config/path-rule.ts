/**
 * The router-rule clause for a Domain's public `path`, shared by both
 * emitters — the file provider (`./domain.ts`) and compose labels
 * (`compose/compose.utils.ts`) — so the two cannot disagree about what a path
 * routes.
 *
 * **A path matches on a segment boundary.** Traefik's `PathPrefix` is a
 * plain string prefix, so ``PathPrefix(`/api`)`` also took `/apix` and
 * `/apiary`, and with strip-path on `/apix` reached the container as `/x`. So
 * `/api` emits ``(PathPrefix(`/api/`) || Path(`/api`))``: exactly `/api`, and
 * everything under `/api/`. The parentheses matter, because the clause is
 * joined to ``Host(…)`` with `&&`, which binds tighter than `||`.
 *
 * A path that already ends in `/` is its own boundary and stays a plain
 * prefix, as it always was: `/v2/` routes `/v2/…` and not `/v2`. `'/'`, empty
 * and `null` add no clause — the whole host.
 *
 * The strip-prefix middleware keeps the path as written: stripping `/api`
 * sends `/api/x` as `/x` and a request for exactly `/api` as `/`.
 *
 * **Priority is unaffected in the way that matters.** No domain router sets
 * `priority`, so Traefik ranks by rule length, and the clause grows with the
 * path: a deeper path still outranks a shallower one, and every pathed router
 * outranks the host's bare ``Host(…)``.
 */
export const pathRuleClause = (path: string | null | undefined): string => {
  if (!path || path === '/') return '';
  if (path.endsWith('/')) return ` && PathPrefix(\`${path}\`)`;
  return ` && (PathPrefix(\`${path}/\`) || Path(\`${path}\`))`;
};
