import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CopyButton } from "@/components/console/copy-button";
import { EmptyState } from "@/components/console/empty-state";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { redirectUriFor, type SsoProvider } from "@/lib/api/endpoints/sso";

import type { Stopped } from "../business-plan";
import { ProviderFormModal } from "./provider-form-modal";
import { useRemoveSsoProvider, useSsoRedirectUri } from "./use-sso";

/**
 * The identity providers registered for this Organization.
 *
 * Not a `DataTable`: a provider is four facts of very different shapes — an id,
 * a URL, a list of email domains and whether a secret is stored — and three of
 * them are long enough to need their own line. A table would have made four
 * columns of which two truncate.
 *
 * **The redirect URI is on the row**, not only in the dialog: an operator
 * re-registering a provider at their identity provider needs it without editing
 * anything. It is
 * a SAML provider's one omission — that one is answered at
 * `/sso/saml2/callback/:providerId`, a path nothing in this console configures.
 *
 * **A SAML provider is listed and cannot be edited here.** The plugin's table
 * carries both blobs; nothing in this console writes SAML, and
 * `forward-auth.service.ts` refuses one outright ("Forward-auth requires an OIDC
 * provider — SAML is not supported"). So it is shown for what it is rather than
 * hidden — an Organization that has one should see it — with the edit control
 * off and the reason in place, F03's inert rule.
 */
export function ProvidersCard({
  providers,
  stopped = null,
}: {
  providers: SsoProvider[];
  /**
   * Kept but stopped: the providers are shown read-only, Add and Edit
   * off with the reason, Remove on.
   */
  stopped?: Stopped | null;
}) {
  const remove = useRemoveSsoProvider();
  const redirectUri = useSsoRedirectUri();
  const [editing, setEditing] = useState<{ provider?: SsoProvider } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<SsoProvider | null>(null);

  return (
    <>
      <Card>
        <Card.Header
          title="Identity providers"
          sub="Members whose email is on one of a provider's domains sign in through it."
          headingLevel={2}
          actions={
            <Button
              type="button"
              size="sm"
              variant="pri"
              disabled={stopped !== null}
              title={stopped?.reason}
              onClick={() => setEditing({})}
            >
              Add a provider
            </Button>
          }
        />
        <Card.Body
          className={providers.length === 0 ? undefined : "grid gap-2"}
        >
          {providers.length === 0 ? (
            <EmptyState icon="key" title="No identity providers yet">
              Add a provider and anyone with an email address on its domains signs
              in through it instead of with a password.
            </EmptyState>
          ) : (
            providers.map((provider) => {
              const saml = !provider.oidcConfig && provider.hasSamlConfig;
              return (
                <div
                  key={provider.id}
                  className="grid gap-2 rounded-lg border border-line bg-panel-2 p-3"
                >
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-1.75 text-body font-medium text-tx">
                        {provider.providerId}
                        {saml ? <Chip>SAML</Chip> : <Chip>OIDC</Chip>}
                        {provider.hasClientSecret ? (
                          <Chip>Secret stored</Chip>
                        ) : null}
                        {stopped ? (
                          <Chip variant="warn">Off {stopped.where}</Chip>
                        ) : null}
                      </p>
                      <p className="mt-0.5 truncate font-mono text-meta text-tx-2">
                        {provider.issuer}
                      </p>
                    </div>
                    <div className="flex flex-none gap-1.5">
                      <Button
                        type="button"
                        size="xs"
                        disabled={stopped !== null}
                        title={stopped?.reason}
                        aria-disabled={saml || stopped ? true : undefined}
                        onClick={() => !saml && setEditing({ provider })}
                      >
                        Edit
                      </Button>
                      <Button
                        type="button"
                        size="xs"
                        variant="dngr"
                        onClick={() => setDeleting(provider)}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>

                  <p className="text-meta text-tx-2">
                    {saml ? (
                      <>
                        A SAML provider. Cloudgate&rsquo;s console only edits
                        OIDC configuration, so this one can be removed here and
                        changed nowhere.
                      </>
                    ) : (
                      <>
                        Signs in{" "}
                        <span className="font-mono text-tx">
                          {provider.domains.join(", ")}
                        </span>
                      </>
                    )}
                  </p>

                  {!saml && redirectUri.data ? (
                    <p className="flex items-center gap-1.5 text-meta text-tx-2">
                      <span className="flex-none">Redirect URI</span>
                      <span
                        className="min-w-0 truncate font-mono text-tx"
                        title={redirectUriFor(
                          redirectUri.data,
                          provider.providerId,
                        )}
                      >
                        {redirectUriFor(redirectUri.data, provider.providerId)}
                      </span>
                      <CopyButton
                        value={redirectUriFor(
                          redirectUri.data,
                          provider.providerId,
                        )}
                        label="redirect URI"
                        size="icon-xs"
                      />
                    </p>
                  ) : null}
                </div>
              );
            })
          )}
        </Card.Body>
      </Card>

      {editing ? (
        <ProviderFormModal
          key={editing.provider?.providerId ?? "new"}
          provider={editing.provider}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {deleting ? (
        <Modal open onOpenChange={(next) => !next && setDeleting(null)}>
          <Modal.Header
            title={`Remove ${deleting.providerId}?`}
            description={`Nobody on ${deleting.domains.join(", ") || "its domains"} will be able to sign in through it.`}
          />
          <Modal.Body className="grid gap-3">
            <div className="rounded-lg border border-bad-line bg-bad-tint p-3 text-ui text-tx">
              If single sign-on is required on this instance and this is the
              only provider, removing it leaves nobody a way in — including you.
            </div>
            <p className="text-body text-tx-2">
              Accounts already created through it stay, and so do their
              memberships. What goes is the way those people prove who they are.
              A forward-auth proxy deployed against this provider stops
              authenticating too.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" onClick={() => setDeleting(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="dngr"
              disabled={remove.isPending}
              aria-busy={remove.isPending || undefined}
              onClick={async () => {
                try {
                  await remove.mutateAsync(deleting.providerId);
                  toast.done(`${deleting.providerId} removed.`);
                  setDeleting(null);
                } catch (error) {
                  toast.error(error);
                }
              }}
            >
              Remove the provider
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </>
  );
}
