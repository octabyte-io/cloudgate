import { useState } from "react";

import { Field } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api/error-message";
import type {
  AuthCertificateType,
  ForwardAuthTarget,
} from "@/lib/api/endpoints/forward-auth";

/**
 * The host the proxy answers on, and how it is served.
 *
 * Its own file rather than a section of `target-card.tsx`, which held three
 * components and 527 lines — F10's precedent when its restore modal and previews
 * panel grew past the budget.
 */
export function AuthDomainModal({
  target,
  pending,
  onClose,
  onSave,
}: {
  target: ForwardAuthTarget;
  pending: boolean;
  onClose: () => void;
  onSave: (input: {
    serverId: string | null;
    authDomain: string;
    https: boolean;
    certificateType: AuthCertificateType;
    customCertResolver?: string | null;
  }) => Promise<void>;
}) {
  const [host, setHost] = useState(target.authDomain ?? "");
  const [https, setHttps] = useState(target.https);
  const [certificateType, setCertificateType] = useState<AuthCertificateType>(
    target.certificateType,
  );
  const [resolver, setResolver] = useState(target.customCertResolver ?? "");
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={`Authentication domain for ${target.name}`}
        description="The host the proxy answers on. It needs DNS pointing here, like any other domain."
      />
      <form
        method="post"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          // Said under Host rather than by a disabled button.
          if (host.trim() === "") {
            setRefusal("Enter the host the proxy answers on.");
            return;
          }
          setRefusal(null);
          try {
            await onSave({
              serverId: target.serverId,
              authDomain: host.trim().toLowerCase(),
              https,
              certificateType,
              /*
                **Omitted, not nulled.** `setForwardAuthSettingsSchema` types
                this `z.string().optional()`, so a `null` is a 400 — "expected
                string, received null" — which is F10's second defect in its
                third form. The rule in `design-system.md` is that an empty
                optional is `undefined` when creating and `null` when updating;
                this route takes neither, so the field simply does not go.
              */
              ...(certificateType === "custom" && resolver.trim()
                ? { customCertResolver: resolver.trim() }
                : {}),
            });
          } catch (error) {
            setRefusal(errorMessage(error));
          }
        }}
      >
        <Modal.Body className="grid gap-3.5">
          <Field
            name="authDomain"
            label="Host"
            error={refusal ?? undefined}
            hint="A hostname, not a URL — auth.example.com. It is stored lower case, and its parent domain becomes the cookie domain, so it has to share one with the Applications it protects."
          >
            <Input
              value={host}
              autoComplete="off"
              spellCheck={false}
              placeholder="auth.example.com"
              onChange={(event) => setHost(event.target.value)}
            />
          </Field>

          <div className="flex items-start gap-3 rounded-lg bg-panel-2 px-3.5 py-3">
            <Switch
              id="forward-auth-https"
              checked={https}
              className="mt-0.5"
              onCheckedChange={(next) => {
                setHttps(next);
                // HTTPS with no issuer produces a router Traefik cannot serve,
                // which is F09's first refusal on a domain in another form. So
                // turning it on picks Let's Encrypt rather than leaving a
                // combination that only fails later.
                if (next && certificateType === "none") {
                  setCertificateType("letsencrypt");
                }
              }}
            />
            <label
              htmlFor="forward-auth-https"
              className="min-w-0 text-body text-tx"
            >
              Serve it over HTTPS
              <span className="mt-0.5 block text-meta text-tx-2">
                An identity provider will refuse a plain-HTTP redirect URI in
                anything but a local test.
              </span>
            </label>
          </div>

          {https ? (
            <Field
              name="certificateType"
              label="Certificate"
              manual
              hint="Let's Encrypt issues one for this host. A custom resolver has to be configured in Traefik's static config first."
            >
              <Picker
                value={certificateType}
                onValueChange={(next) =>
                  setCertificateType(next as AuthCertificateType)
                }
                options={[
                  { value: "letsencrypt", label: "Let's Encrypt" },
                  { value: "custom", label: "A custom resolver" },
                  { value: "none", label: "None" },
                ]}
              />
            </Field>
          ) : null}

          {https && certificateType === "custom" ? (
            <Field
              name="customCertResolver"
              label="Resolver name"
              hint="The name of a certificate resolver in Traefik's static configuration."
            >
              <Input
                value={resolver}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setResolver(event.target.value)}
              />
            </Field>
          ) : null}
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="pri"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            Save the domain
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
