/**
 * The words of every Restart Traefik confirm — the Requests screen's
 * `RestartTraefikModal` and the Settings → Traefik danger zone's.
 *
 * Shared because the two drifted: the Settings one borrowed the destructive
 * deletes' "This cannot be undone." for a restart that loses nothing — the same
 * container, configuration and routes are back a second or so later. What a
 * restart costs is a disruption, and that is what both say.
 *
 * Only the words are here, not the dialog: the two confirms sit in different
 * shells — a `DangerZone` action on Settings, a bare `Modal` on Requests — and
 * each already has its own. The consequences take `change`, the one clause
 * that differs: what the restart is being done to make take effect.
 */
export const RESTART_TRAEFIK_DESCRIPTION =
  "This is the ingress that serves every domain on the platform host.";

/** The toast afterwards. "Asked", because the route answers before the restart. */
export const RESTART_TRAEFIK_DONE =
  "Cloudgate has asked Docker to restart Traefik.";

export function RestartTraefikConsequences({
  change,
}: {
  /** What the restart makes take effect: "a change to request logging". */
  change: React.ReactNode;
}) {
  return (
    <>
      <p className="text-body text-tx-2">
        Traefik re-reads <code className="font-mono">traefik.yml</code> only
        when it starts, so this is what makes {change} take effect.{" "}
        <strong className="font-medium text-tx">
          Every connection it is currently serving is dropped
        </strong>{" "}
        and requests fail until it is back — a second or two when it is idle,
        longer under load. If this console is served through Traefik, it drops
        too.
      </p>
      <p className="mt-3 text-meta text-tx-3">
        Cloudgate asks Docker to restart the container and answers immediately,
        so nothing here can report whether it came back up. The Monitoring
        screen&rsquo;s health readout is where that is checked.
      </p>
    </>
  );
}
