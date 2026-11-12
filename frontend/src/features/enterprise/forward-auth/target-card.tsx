import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CopyButton } from "@/components/console/copy-button";
import { KVList, KVRow } from "@/components/console/kv-list";
import { toast } from "@/components/console/toast";
import type {
  ForwardAuthProvider,
  ForwardAuthTarget,
} from "@/lib/api/endpoints/forward-auth";

import type { Stopped } from "../business-plan";
import { AuthDomainModal } from "./auth-domain-modal";
import { DeployProxyModal } from "./deploy-proxy-modal";
import { ProxyStatus } from "./proxy-status";
import { TargetActions } from "./target-actions";
import { useDeployProxy, useSetAuthDomain } from "./use-forward-auth";

/**
 * One Traefik instance, and the two steps that put a proxy in front of it.
 *
 * **The order is forced by the backend and the card follows it** — the domain
 * comes first and deploying is inert with its reason until it is set, which is
 * `target-actions.tsx`. What the probe can and cannot tell you is `proxy-status.tsx`,
 * and the limitation is stated here, under the reading it qualifies.
 *
 * ## The local target is a real target
 *
 * `serverId: null` is Cloudgate's own host, and it is first in the list. Every
 * route here takes the id as nullable for that reason, and so does every query
 * key — `keys.docker` and `keys.traefik` made the same choice for the same
 * reason.
 */
export function TargetCard({
  target,
  providers,
  stopped = null,
}: {
  target: ForwardAuthTarget;
  providers: ForwardAuthProvider[];
  /**
   * Kept but stopped: a running proxy is "Still protected", setting
   * up is off, removing stays on.
   */
  stopped?: Stopped | null;
}) {
  const setDomain = useSetAuthDomain();
  const deploy = useDeployProxy();

  const [editing, setEditing] = useState(false);
  const [choosing, setChoosing] = useState(false);

  const configured = target.authDomain !== null;

  return (
    <>
      <Card>
        <Card.Header
          title={target.name}
          sub={
            target.serverId === null
              ? "The Traefik this instance of Cloudgate runs behind."
              : (target.ipAddress ?? "A deploy Server in this Organization.")
          }
          headingLevel={2}
          actions={
            <span className="flex items-center gap-1.5">
              {stopped && target.status === "running" ? (
                <Chip variant="ok">Still protected</Chip>
              ) : null}
              <ProxyStatus status={target.status} />
            </span>
          }
        />

        <Card.Body className="grid gap-3.5">
          {configured ? (
            <KVList>
              <KVRow
                label="Auth domain"
                mono
                value={target.authDomain}
                title={target.authDomain ?? undefined}
              />
              <KVRow label="Scheme" value={target.https ? "HTTPS" : "HTTP"} />
              <KVRow
                label="Certificate"
                value={
                  target.certificateType === "letsencrypt"
                    ? "Let's Encrypt"
                    : target.certificateType === "custom"
                      ? (target.customCertResolver ?? "A custom resolver")
                      : "None"
                }
              />
              {target.callbackUrl ? (
                <KVRow
                  label="Redirect URI"
                  mono
                  value={target.callbackUrl}
                  title={target.callbackUrl}
                  action={
                    <CopyButton
                      value={target.callbackUrl}
                      label="redirect URI"
                      size="icon-xs"
                    />
                  }
                />
              ) : null}
            </KVList>
          ) : (
            <p className="text-body text-tx-2">
              No authentication domain is set for this target. The proxy answers
              on a host of its own —{" "}
              <code className="font-mono">/oauth2/*</code> — and that host has
              to exist before a proxy can be stood up.
            </p>
          )}

          {configured && target.callbackUrl ? (
            <p className="text-meta text-tx-2">
              Add the redirect URI above to your identity provider&rsquo;s
              allowed list, or the sign-in it sends people through will be
              refused at the last step.
            </p>
          ) : null}

          {/* The reading's limits, where the reading is. See `ProxyStatus`. */}
          {target.status === "running" ? (
            <p className="text-meta text-tx-3">
              &ldquo;Deployed&rdquo; means a replica of the proxy is running on
              this target, not that it answers sign-ins. Check it with{" "}
              <code className="font-mono">
                docker service logs cloudgate-forward-auth
              </code>{" "}
              before you put a domain behind it.
            </p>
          ) : target.status === "failing" ? (
            <p className="text-meta text-tx-2">
              The proxy is deployed but not starting
              {target.message ? (
                <>
                  {" — "}
                  <span className="font-mono">{target.message}</span>
                </>
              ) : null}
              . A wrong client secret or an unreachable issuer looks like this.
            </p>
          ) : null}

          {stopped && target.status === "running" ? (
            <p className="text-meta text-tx-2">
              Domains already behind this proxy stay behind the sign-in.
              Removing the proxy opens them to anyone with the link.
            </p>
          ) : null}

          <TargetActions
            stopped={stopped}
            target={target}
            providers={providers}
            configured={configured}
            onEditDomain={() => setEditing(true)}
            onChooseProvider={() => setChoosing(true)}
          />
        </Card.Body>
      </Card>

      {editing ? (
        <AuthDomainModal
          target={target}
          pending={setDomain.isPending}
          onClose={() => setEditing(false)}
          onSave={async (input) => {
            const result = await setDomain.mutateAsync(input);
            setEditing(false);
            toast.done(
              `The proxy on ${target.name} will answer at ${result.callbackUrl}.`,
            );
          }}
        />
      ) : null}

      {choosing ? (
        <DeployProxyModal
          target={target}
          providers={providers}
          pending={deploy.isPending}
          onClose={() => setChoosing(false)}
          onDeploy={async (providerId) => {
            await deploy.mutateAsync({ serverId: target.serverId, providerId });
            setChoosing(false);
            toast.done(`The proxy is up on ${target.name}.`);
          }}
        />
      ) : null}
    </>
  );
}
