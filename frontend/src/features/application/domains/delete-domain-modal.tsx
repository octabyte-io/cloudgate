import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type { Domain } from "@/lib/api/endpoints/domains";
import { errorMessage } from "@/lib/api/error-message";

import { useDeleteDomain, useParentDomains } from "./use-domains";

/**
 * Remove a domain.
 *
 * **No typed confirmation**, unlike deleting a Project or an Environment, and the
 * difference is recoverability: a deleted domain is one row that can be added back
 * in ten seconds from the same dialog, and nothing deployed is destroyed. A typed
 * name for a reversible action trains people to type names, which is how the
 * irreversible one eventually gets typed without being read.
 *
 * What it does say is when the host stops answering, and it once
 * said that wrong: for an **Application** the route is gone immediately,
 * because `DomainsService.remove` awaits `regenerateTraefikConfig` inside the
 * request and Traefik's file provider reloads the rewritten file in under a
 * second. For a **Compose stack** it does wait for a deploy —
 * `regenerateTraefikConfig` returns early for one, since a stack's routers
 * travel as labels injected at deploy time.
 *
 * Which parent it is is not a guess: exactly one of `applicationId` / `composeId` is
 * given, and that is also what the noun defaults from — the Compose panel passes the
 * id and no `noun`, so this dialog used to call a stack an Application.
 *
 * **A domain is a route, not a host**. One host can carry several — `/`
 * and `/api` are two rows and two routers — so a domain with a path is named by
 * host *and* path in the title, the body and the toast, and the body only says
 * the host stops answering when no other route on it remains. It reads that from
 * the parent's own domain list, which the tab this opens from already holds.
 */
export function DeleteDomainModal({
  applicationId,
  composeId,
  bucketId,
  domain,
  open,
  onOpenChange,
  noun,
}: {
  /** Exactly one of these — a domain belongs to an Application or to a stack. */
  applicationId?: string;
  composeId?: string;
  /** A Server bucket's Domain, whose last one is its endpoint. */
  bucketId?: string;
  domain: Domain | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What stops answering, for the sentence that says so. Defaults from the id. */
  noun?: string;
}) {
  const onCompose = composeId !== undefined;
  const owner =
    noun ??
    (onCompose ? "stack" : bucketId !== undefined ? "bucket" : "Application");
  // `DELETE /domains/:id` takes no parent, so the parent is only ever the
  // invalidation target — which is why one hook serves both and takes whichever
  // id it was given. A hook cannot be called conditionally, so the unused half is
  // called with an empty id and never fires: this is a mutation, not a query.
  const remove = useDeleteDomain({ applicationId, composeId, bucketId });
  const parentDomains = useParentDomains({
    applicationId,
    composeId,
    bucketId,
  });
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!domain) return null;

  const path = domain.path && domain.path !== "/" ? domain.path : null;
  // What is being removed, as the operator would tell it from its neighbours.
  const route = path ? `${domain.host}${path}` : domain.host;
  // The other routes on this host. Hosts compare without case, as DNS does.
  const others = (parentDomains.data ?? []).filter(
    (other) =>
      other.domainId !== domain.domainId &&
      other.host.toLowerCase() === domain.host.toLowerCase(),
  );
  const otherPaths = others.map((other) => other.path || "/");
  const rootRemains = otherPaths.includes("/");
  // A bucket's last Domain is its `endpoint`: without one, linked
  // Services get its internal URL at their next deploy.
  const lastOfBucket =
    bucketId !== undefined &&
    parentDomains.data !== undefined &&
    parentDomains.data.every((other) => other.domainId === domain.domainId);

  const when = onCompose ? (
    <>
      after {others.length > 0 ? "this stack’s" : "its"}{" "}
      next Deployment — a stack&rsquo;s routers travel as labels injected then,
      so the old one stays in place until it runs.
    </>
  ) : (
    <>
      straight away: Traefik&rsquo;s configuration is rewritten as this dialog
      closes, and it reloads within a second. No Deployment is needed.
    </>
  );

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Remove ${route}?`}
        description="Nothing deployed is deleted — only this route."
      />
      <Modal.Body>
        {others.length > 0 ? (
          <p className="text-body text-tx-2">
            This route stops answering {when}{" "}
            <strong className="font-medium text-tx">{domain.host}</strong> keeps
            answering on its other {others.length === 1 ? "route" : "routes"},{" "}
            <span className="font-mono">{otherPaths.join(", ")}</span>.{" "}
            {path && rootRemains ? (
              <>
                A request under <span className="font-mono">{path}</span> is
                served by the <span className="font-mono">/</span> route instead.
              </>
            ) : (
              <>
                A request {others.length === 1 ? "it does not cover" : "none of them covers"}{" "}
                gets Traefik&rsquo;s 404.
              </>
            )}{" "}
            You can add the route back at any time.
          </p>
        ) : (
          <p className="text-body text-tx-2">
            This {owner} stops answering on{" "}
            <strong className="font-medium text-tx">{route}</strong> {when}{" "}
            You can add the {path ? "route" : "host"} back at any time.
          </p>
        )}
        {lastOfBucket ? (
          <p className="text-body text-warn">
            It is this bucket&rsquo;s last Domain. Its endpoint becomes its
            internal URL at each linked Service&rsquo;s next deploy, and
            presigned URLs and browser uploads stop working until it has a
            Domain again.
          </p>
        ) : null}
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={remove.isPending}
          aria-busy={remove.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await remove.mutateAsync(domain.domainId);
              toast.done(`${route} removed.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Remove domain
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
