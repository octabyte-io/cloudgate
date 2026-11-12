import { LinkButton } from "@/components/console/link-button";

/**
 * What every card on a Server's tabs says when the Server was not reached.
 *
 * The same fact used to be worded four ways across Overview, Infrastructure,
 * Access and Docker & Swarm, and the remedies disagreed: some cards sent the
 * operator to the Access tab for the key, some to the Settings tab for the
 * address — and the one control that actually tries again, **Check now**, is on
 * Infrastructure and none of them linked to it. So the block is one component:
 * the fact, what this card's command therefore cannot claim, and the way to
 * Check now, which stores and shows SSH's own words for the cause.
 *
 * `ran` is the card's own question — `docker ps`, `docker node ls` — and
 * `children` the one sentence about what the silence does *not* mean, which is
 * the part that differs per card and is the reason the block exists at all: a
 * Server nobody reached is not an empty one.
 */
export function ServerUnreachable({
  serverId,
  ran,
  children,
}: {
  serverId: string;
  /** What never ran, e.g. `<code>docker ps</code>`. */
  ran: React.ReactNode;
  /** What that does not mean, as one sentence. */
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-body text-tx">
        Cloudgate could not reach this Server.
      </p>
      <p className="mt-1.5 text-meta text-tx-2">
        {ran} never ran, so {children}
      </p>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <LinkButton size="sm" href={`/servers/${serverId}/infrastructure`}>
          Check now
        </LinkButton>
        <p className="min-w-0 flex-1 text-meta text-tx-3">
          On the Infrastructure tab, with SSH&rsquo;s own words for why. The
          address and port are on the Settings tab, the key on the Access tab.
        </p>
      </div>
    </div>
  );
}
