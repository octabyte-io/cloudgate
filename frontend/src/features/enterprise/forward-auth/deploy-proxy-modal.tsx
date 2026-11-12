import { useState } from "react";

import { Field } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type {
  ForwardAuthProvider,
  ForwardAuthTarget,
} from "@/lib/api/endpoints/forward-auth";

/** Which identity provider the proxy on this target authenticates against. */
export function DeployProxyModal({
  target,
  providers,
  pending,
  onClose,
  onDeploy,
}: {
  target: ForwardAuthTarget;
  providers: ForwardAuthProvider[];
  pending: boolean;
  onClose: () => void;
  onDeploy: (providerId: string) => Promise<void>;
}) {
  const [providerId, setProviderId] = useState(providers[0]?.providerId ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={`Deploy the proxy on ${target.name}`}
        description="An oauth2-proxy container is started there and connected to Traefik."
      />
      <form
        method="post"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          setRefusal(null);
          try {
            await onDeploy(providerId);
          } catch (error) {
            setRefusal(errorMessage(error));
          }
        }}
      >
        <Modal.Body className="grid gap-3.5">
          <Field
            name="providerId"
            label="Authenticate against"
            manual
            error={refusal ?? undefined}
            hint="Only OIDC providers are listed — oauth2-proxy does not speak SAML."
          >
            <Picker
              value={providerId}
              onValueChange={setProviderId}
              options={providers.map((provider) => ({
                value: provider.providerId,
                label: provider.providerId,
                detail: provider.issuer,
              }))}
            />
          </Field>
          <p className="text-meta text-tx-2">
            The proxy is given this provider&rsquo;s client id and secret, and a
            cookie secret derived for this target. Nothing about it is stored in
            the browser.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="pri"
            disabled={pending || providerId === ""}
            aria-busy={pending || undefined}
          >
            Deploy it
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
