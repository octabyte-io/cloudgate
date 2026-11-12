import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api/error-message";

import { useDomainGate, useSetDomainGate } from "./use-forward-auth";

/**
 * **The per-domain half of forward auth, rendered where the domain is.**
 *
 * This is F18's one component that lives on somebody else's screen, and the
 * reason is in `forward-auth-section.tsx`: nothing enumerates an Organization's
 * domains. The services *can*
 * be enumerated now, so what stands between the settings screen and a
 * list of gated hosts is a fan-out per Project, Environment and service rather
 * than a missing route — and the switch does not need one. It exists one row at a
 * time on F09's domains table, which already holds the `domainId` and already
 * knows whether the row is an Application's.
 *
 * It is written to be droppable into a table cell: no card, no heading, no
 * assumptions about what is around it.
 *
 * ## Not gated by the licence, and that is the backend's decision
 *
 * These three routes ride the `domain` permission plus row-level service access,
 * not `ensureEnterprise`, deliberately: a member with domain rights goes on
 * managing gates after an owner has stood the proxy up. So this must render outside `LicenseGate` and must handle a refusal that
 * is not about a licence.
 *
 * ## The refusals are the useful part
 *
 * `enableOnDomain` throws a **412** with one of two sentences, and both name the
 * screen to go to:
 *
 * - "Deploy the authentication proxy for this server in SSO settings first."
 * - "The authentication proxy is not deployed on this server. Deploy it in SSO
 *   settings first."
 *
 * F02's status rules have no sentence for a 412, so the backend's own message is
 * what gets shown — which is right here, unusually: it is more specific than
 * anything this component could say, because only the backend knows whether the
 * proxy is *recorded* or *actually running*.
 *
 * A refusal leaves the switch where it was. There is no optimistic update:
 * turning a gate on is a claim about whether a person can reach a running
 * Application, and showing it as on while the request is refused is the one lie
 * this control must not tell.
 *
 * ## Accepting is not the same as working
 *
 * The precondition the backend checks is `isRunning`, which inspects the Swarm
 * **service object** and not its tasks — so a crash-looping proxy passes it
 * Driven: a proxy
 * at `0/1` replicas accepted the enable and the domain went behind a middleware
 * that answers nothing. Nothing here can detect that — no route reports the task
 * state — so the confirmation says what turning it on *did*, and does not claim
 * the host now asks for a sign-in.
 */
export function DomainGateSwitch({
  domainId,
  /** Off for a Compose domain, which the backend refuses outright. */
  supported = true,
  host,
}: {
  domainId: string;
  supported?: boolean;
  host: string;
}) {
  const gate = useDomainGate(domainId, supported);
  const set = useSetDomainGate(domainId);

  if (!supported) return null;

  if (gate.isPending) return <Skeleton className="h-4.5 w-8 rounded-pill" />;

  if (gate.error) {
    // Either way this is a control the reader cannot use, so it says so rather
    // than rendering a switch that will refuse. *Which* way is `errorMessage()`'s
    // to decide and was this component's until H-37: it read `isForbidden` and
    // answered "Your role cannot manage this" for every 403, which is the exact
    // shape H-26 removed from `errorMessage()` itself. A **banned** operator's
    // 403 arrives here like any other and their role is not the problem — the
    // one sentence that would have helped them is the one this branch could not
    // say. Deciding wording from a status is a decision this file is not the
    // place to make, and now does not.
    //
    // The refusal is not only the `domain` permission either. `domainStatus`
    // rides row-level service access as well, so a member with domain rights and
    // no access to the Application behind this row is refused for a reason
    // "your role" describes badly — and the non-403 half threw the backend's own
    // message away, which is the half this file's docblock argues *against*
    // doing for the 412s on the write.
    // `whitespace-normal` and a width, because `table.tsx` puts
    // `whitespace-nowrap` on every `<td>` and this column deliberately does not
    // take `DataTable`'s `wrap` tone — `min-w-55` on the column would widen it
    // by 220px for everyone to serve the case where the switch is refused. The
    // sentence `errorMessage()` returns is ~110 characters where the old one
    // was four words, so without this it renders as one unbroken line, the
    // table grows to fit it, and Host, Path, Port, Scheme and Certificate are
    // pushed out behind a horizontal scrollbar. `useDomainGate` is per row, so
    // a refused member gets that line in *every* row.
    return (
      <span className="text-meta text-tx-3 block max-w-55 whitespace-normal">
        {errorMessage(gate.error)}
      </span>
    );
  }

  return (
    <Switch
      checked={gate.data?.enabled === true}
      disabled={set.isPending}
      aria-label={`Require sign-in for ${host}`}
      onCheckedChange={async (next) => {
        try {
          await set.mutateAsync(next);
          toast.done(
            next
              ? `${host} is now routed through the authentication proxy. If that proxy is not actually up, the host will stop answering.`
              : `${host} is open again.`,
          );
        } catch (error) {
          toast.error(error);
        }
      }}
    />
  );
}
