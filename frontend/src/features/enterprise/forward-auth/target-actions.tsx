import { useState } from "react";

import { Modal } from "@/components/console/modal";
import { TeardownReportModal } from "@/components/console/teardown-report-modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type {
  ForwardAuthProvider,
  ForwardAuthTarget,
} from "@/lib/api/endpoints/forward-auth";
import type { TeardownReport } from "@/lib/api/endpoints/teardown";

import type { Stopped } from "../business-plan";
import { useRemoveAuthDomain, useRemoveProxy } from "./use-forward-auth";

/**
 * The controls, and the two sentences that say why one of them is off.
 *
 * **The order is forced by the backend.** `deployOnServer` throws a `412` — "Set
 * the authentication domain for this server before deploying the proxy." —
 * without a settings row, so deploying is inert until the domain is set, and it
 * says so in place rather than being hidden (F03's one inert rule). The second
 * reason is the provider list: a proxy authenticates against an OIDC provider, and
 * oauth2-proxy does not speak SAML.
 *
 * **Both destructive controls ask first**, as the SCIM card's removal on
 * the same page does: removing the proxy breaks every gated domain on the
 * first click, and clearing the domain takes the proxy's /oauth2 router with
 * it while the proxy may still be running.
 */
export function TargetActions({
  target,
  providers,
  configured,
  onEditDomain,
  onChooseProvider,
  stopped = null,
}: {
  /** Kept but stopped: setting up is off with why, removing is on. */
  stopped?: Stopped | null;
  target: ForwardAuthTarget;
  providers: ForwardAuthProvider[];
  /** Whether an authentication domain has been set for this target. */
  configured: boolean;
  onEditDomain: () => void;
  onChooseProvider: () => void;
}) {
  const removeDomain = useRemoveAuthDomain();
  const removeProxy = useRemoveProxy();
  const [confirming, setConfirming] = useState<"proxy" | "domain" | null>(null);
  const [leftBehind, setLeftBehind] = useState<TeardownReport | null>(null);
  const authHost = target.authDomain ?? "the authentication domain";
  // A failing proxy is still a deployed service, and the likeliest one
  // to want removing.
  const deployed = target.status === "running" || target.status === "failing";

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          disabled={stopped !== null}
          title={stopped?.reason}
          onClick={onEditDomain}
        >
          {configured ? "Change the domain" : "Set an authentication domain"}
        </Button>

        {deployed ? (
          <Button
            type="button"
            size="sm"
            variant="dngr"
            onClick={() => setConfirming("proxy")}
          >
            Remove the proxy
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="pri"
            disabled={stopped !== null}
            title={stopped?.reason}
            aria-disabled={
              stopped || !configured || providers.length === 0
                ? true
                : undefined
            }
            onClick={() =>
              configured && providers.length > 0 && onChooseProvider()
            }
          >
            Deploy the proxy
          </Button>
        )}

        {configured ? (
          <Button
            type="button"
            size="sm"
            variant="qt"
            onClick={() => setConfirming("domain")}
          >
            Clear the domain
          </Button>
        ) : null}
      </div>

      {stopped ? null : !configured ? (
        <p className="text-meta text-tx-3">
          Deploying is off until a domain is set — the backend refuses it
          without one.
        </p>
      ) : providers.length === 0 ? (
        <p className="text-meta text-tx-3">
          Deploying is off because no OIDC provider is registered. A proxy
          authenticates against one, and oauth2-proxy does not speak SAML.
        </p>
      ) : null}

      {confirming === "proxy" ? (
        <Modal open onOpenChange={(next) => !next && setConfirming(null)}>
          <Modal.Header
            title={`Remove the proxy on ${target.name}?`}
            description="Every domain gated by it stops letting anyone in."
          />
          <Modal.Body className="grid gap-3">
            <div className="rounded-lg border border-warn-line bg-warn-tint p-3 text-ui text-tx">
              The oauth2-proxy service is stopped and its router on{" "}
              <span className="font-mono">{authHost}</span> is removed. Any
              Application domain whose gate is on can no longer send its
              visitors through sign-in, so it fails every request until the
              proxy is deployed again or its gate is turned off.
            </div>
            <p className="text-body text-tx-2">
              The authentication domain and its redirect URI stay, so deploying
              the proxy again puts it back as it was.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="dngr"
              disabled={removeProxy.isPending}
              aria-busy={removeProxy.isPending || undefined}
              onClick={async () => {
                try {
                  const result = await removeProxy.mutateAsync(target.serverId);
                  setConfirming(null);
                  if (result.unreclaimedArtifacts?.length) {
                    setLeftBehind({
                      unreclaimedArtifacts: result.unreclaimedArtifacts,
                    });
                  } else {
                    toast.done(`The proxy on ${target.name} has been removed.`);
                  }
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Remove the proxy
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}

      {confirming === "domain" ? (
        <Modal open onOpenChange={(next) => !next && setConfirming(null)}>
          <Modal.Header
            title={`Clear the authentication domain for ${target.name}?`}
            description={`${authHost} stops answering sign-ins.`}
          />
          <Modal.Body className="grid gap-3">
            <div className="rounded-lg border border-warn-line bg-warn-tint p-3 text-ui text-tx">
              Its /oauth2 router and settings are removed.
              {deployed
                ? " The proxy is still deployed, but nothing reaches it any more, so every domain gated by it fails its sign-in."
                : null}
            </div>
            <p className="text-body text-tx-2">
              If you set a different domain later, its redirect URI has to be
              registered with your identity provider again.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="dngr"
              disabled={removeDomain.isPending}
              aria-busy={removeDomain.isPending || undefined}
              onClick={async () => {
                try {
                  await removeDomain.mutateAsync(target.serverId);
                  setConfirming(null);
                  toast.done(
                    `The authentication domain for ${target.name} has been cleared.`,
                  );
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Clear the domain
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}

      {/* The shared left-behind modal — it keeps itself open against a
          click-away, since this is the only copy of the path. Its delete
          wording is replaced: removing the proxy keeps the settings row, and
          the router left behind answers 502, not 404. */}
      <TeardownReportModal
        report={leftBehind ?? undefined}
        serviceName={`The proxy on ${target.name}`}
        open={leftBehind !== null}
        onOpenChange={(next) => !next && setLeftBehind(null)}
        copy={{
          title: `The proxy on ${target.name} was removed, but its router was not`,
          description:
            "Cloudgate could not delete the router file from the machine that holds it.",
          footnote:
            "This path is not stored anywhere. Saving the authentication domain again retries the removal.",
          panel: {
            record:
              "The proxy is gone. This is the only record of the file — copy it before you close this.",
            urgent: `Until this file is removed, ${target.https ? "https" : "http"}://${authHost}/oauth2/* still matches its router and answers 502, because the service it forwards to is gone.`,
            notes: {
              "traefik-config": `The /oauth2 router for ${authHost}. Delete it on ${target.name}.`,
            },
          },
        }}
      />
    </>
  );
}
