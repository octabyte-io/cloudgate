/**
 * The line under a row that a router Traefik refused named in its chain
 * (H-38/H-62).
 *
 * Words rather than a colour or a glyph (`design-system.md` rule 2), and
 * deliberately **not** a claim that this row is the broken one: Traefik drops
 * the whole router when any middleware in its chain fails to build and logs
 * *which router*, never which link — so a mark that asserted culpability would
 * be a guess dressed as a finding. The Domains tab carries Traefik's own
 * sentence; this says only "you are in the set".
 *
 * Its own file rather than a local function in `networking-specs.tsx`, because
 * that file's exemption from the 400-line budget is by *kind* — three
 * `ResourceSpec` factories with no component in it (`design-system.md`) — and a
 * component defined inside it is exactly what the exemption says it is not.
 */
export function ChainMark() {
  return (
    <span className="text-meta text-bad wrap-anywhere">
      In the chain of a router Traefik refused
    </span>
  );
}
