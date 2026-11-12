import { useSearchParams } from "next/navigation";

import { providerOf } from "./providers";

/**
 * The returning browser lands on this screen with `?connected=<kind>`, having
 * been away at the provider. Without this the trip ends on a page that looks
 * exactly like the one it started on.
 *
 * Read from the URL rather than held in state because the round trip is a full
 * page load — nothing this app set before leaving survives it.
 */
export function ConnectedNotice() {
  const params = useSearchParams();
  const connected = params.get("connected");
  if (connected === null) return null;
  const known = ["github", "gitlab", "gitea", "bitbucket"] as const;
  const kind = known.find((candidate) => candidate === connected);
  if (!kind) return null;

  return (
    <div
      role="status"
      className="rounded-lg border border-ok-line bg-ok-tint px-3.5 py-3 text-body wrap-anywhere text-tx"
    >
      <strong className="font-medium">
        {providerOf(kind).label} finished the handshake.
      </strong>{" "}
      Its credentials are stored. Check the connection below to see which
      repositories it reaches.
    </div>
  );
}
