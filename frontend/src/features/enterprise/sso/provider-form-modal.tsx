import { useState } from "react";

import { CopyButton } from "@/components/console/copy-button";
import { Field, FormError } from "@/components/console/field";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import { redirectUriFor, type SsoProvider } from "@/lib/api/endpoints/sso";

import { OidcFields } from "./oidc-fields";
import {
  buildProviderInput,
  initialValues,
  oidcTouched,
  splitList,
} from "./provider-input";
import { useSaveSsoProvider, useSsoRedirectUri } from "./use-sso";

/**
 * Register an OIDC provider, or change one.
 *
 * ## The secret is the shape of this form, and the reason is the backend's
 *
 * `ssoProviderBodySchema` types `oidcConfig` as optional and `clientSecret` as
 * **required inside it**. So an update has exactly two options: send no OIDC
 * block at all and keep every stored value, or send it complete. There is no way
 * to change a client id, an endpoint or a scope without also retyping the
 * secret — and the console never holds one to resend, because it deletes it at
 * the client boundary.
 *
 * That is stated on the form rather than worked around. Editing a provider and
 * leaving the secret blank sends only `providerId`, `issuer` and `domains`; the
 * moment any OIDC field is touched, the secret becomes required and says why.
 * The alternative — sending a placeholder — would overwrite a working secret
 * with a string that is not one.
 *
 * ## Two rules the backend applies that the form has to explain first
 *
 * **A domain is an email domain**, matched against the address somebody signs in
 * with — not a URL and not a bare label. `domainRegex` refuses anything else,
 * and a domain already claimed by *any* provider on the instance, including
 * another Organization's, is refused as taken.
 *
 * **Every issuer needs its origin trusted, registration included.** Two separate
 * gates say so. `assertIssuerTrusted` is Cloudgate's and refuses an *update*
 * that repoints a provider at a host not on the list. The other is the plugin's,
 * and it is the one this form meets first: discovery will not fetch a document
 * from an untrusted origin, so on a fresh install — where the list is empty —
 * the first provider is refused too
 * That is what
 * *Trust this issuer* is for: an operator who typed an issuer has already said
 * they trust it, so the origin is added as part of registering rather than in a
 * separate visit to the card below. Leaving it off is allowed and the refusal
 * then names the origin and the card.
 *
 * ## What the plugin does to what you send
 *
 * Driven against a real registration: `skipDiscovery` is **dropped** and a
 * `discoveryEndpoint` is derived from the issuer, so the endpoints below are
 * genuinely optional — a provider serving
 * `/.well-known/openid-configuration` needs only the first three fields, once
 * its origin is trusted.
 *
 * ## The redirect URI is shown, not left to be guessed
 *
 * It is `{BETTER_AUTH_URL}{basePath}/sso/callback/{providerId}`, so it exists the
 * moment an id is typed and the identity provider needs it registered before the
 * flow's last step will work. Both halves come from the backend, which is the
 * only party that knows either — `forward-auth/target-card.tsx` shows the
 * proxy's the same way, down to the warning sentence.
 */
export function ProviderFormModal({
  provider,
  onClose,
}: {
  provider?: SsoProvider;
  onClose: () => void;
}) {
  const save = useSaveSsoProvider();
  const redirectUri = useSsoRedirectUri();
  const editing = !!provider;

  const [values, setValues] = useState(() => initialValues(provider));
  const [refusal, setRefusal] = useState<string | null>(null);
  // On by default: the operator typed the issuer, which is the assertion the
  // list is asking for. Nothing is written unless the plugin actually refuses.
  const [trustIssuer, setTrustIssuer] = useState(true);

  const set = (key: keyof typeof values, next: string) =>
    setValues((current) => ({ ...current, [key]: next }));

  const withOidc = oidcTouched(values, provider);
  const providerId = values.providerId.trim();
  const callbackUri =
    providerId && redirectUri.data
      ? redirectUriFor(redirectUri.data, providerId)
      : null;

  async function submit(event: React.SyntheticEvent) {
    event.preventDefault();
    if (save.isPending) return;
    setRefusal(null);

    if (splitList(values.domains).length === 0) {
      setRefusal("Name at least one email domain this provider signs in.");
      return;
    }
    if (withOidc && !values.clientSecret.trim()) {
      setRefusal(
        "Changing any OIDC setting means sending the client secret with it — the backend takes that block whole or not at all.",
      );
      return;
    }

    const input = buildProviderInput(values, withOidc);
    if (!editing && trustIssuer) input.trustIssuer = true;

    try {
      await save.mutateAsync({ existing: editing, values: input });
      toast.done(
        editing
          ? `${input.providerId} updated.`
          : `${input.providerId} registered.`,
      );
      onClose();
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <Modal open wide onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title={editing ? `Edit ${provider.providerId}` : "Add an OIDC provider"}
        description="Members whose email address is on one of these domains sign in through this provider."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body className="grid gap-4">
          <Field
            name="providerId"
            label="Provider id"
            hint={
              editing
                ? "This cannot change — it is how the provider is addressed."
                : "A short name for this connection. It appears in the sign-in URL."
            }
          >
            <Input
              value={values.providerId}
              readOnly={editing}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("providerId", event.target.value)}
            />
          </Field>

          {/* Derived from the id above, so it appears as that is typed and
              before anything is saved — which is when the operator is on the
              identity provider's screen registering it. */}
          {callbackUri ? (
            <div className="grid gap-2 rounded-lg border border-line bg-panel-2 px-3 py-1">
              <KVList>
                <KVRow
                  label="Redirect URI"
                  mono
                  value={callbackUri}
                  title={callbackUri}
                  action={
                    <CopyButton
                      value={callbackUri}
                      label="redirect URI"
                      size="icon-xs"
                    />
                  }
                />
              </KVList>
              <p className="pb-2 text-meta text-tx-2">
                Add the redirect URI above to your identity provider&rsquo;s
                allowed list, or the sign-in it sends people through will be
                refused at the last step.
              </p>
            </div>
          ) : null}

          <Field
            name="issuer"
            label="Issuer URL"
            hint={
              editing
                ? "Moving to a different issuer needs that origin in the trusted origins list below first."
                : "The provider's base URL, e.g. https://login.example.com. Cloudgate reads its discovery document, which it will only fetch from a trusted origin."
            }
          >
            <Input
              value={values.issuer}
              type="url"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set("issuer", event.target.value)}
            />
          </Field>

          {/* Registration only: an update's issuer change is Cloudgate's own
              gate, and it refuses rather than offering to widen the list. */}
          {editing ? null : (
            <div className="flex items-start gap-2.5">
              <Checkbox
                id="trustIssuer"
                className="mt-0.5"
                checked={trustIssuer}
                onCheckedChange={(next) => setTrustIssuer(next === true)}
              />
              <label htmlFor="trustIssuer" className="cursor-pointer">
                <span className="block text-ui text-tx">
                  Trust this issuer
                </span>
                <span className="block text-meta text-tx-2">
                  Adds the issuer&rsquo;s origin to Trusted origins below, which
                  the first provider on this instance needs before its discovery
                  document can be fetched. Leave it off to add the origin
                  yourself first.
                </span>
              </label>
            </div>
          )}

          <Field
            name="domains"
            label="Email domains"
            hint="Comma separated. Email domains, not URLs — example.com, not https://example.com. A domain already claimed by any provider on this instance is refused."
          >
            <Input
              value={values.domains}
              autoComplete="off"
              spellCheck={false}
              placeholder="example.com, example.co.uk"
              onChange={(event) => set("domains", event.target.value)}
            />
          </Field>

          <OidcFields
            values={values}
            set={set}
            editing={editing}
            oidcTouched={withOidc}
            hasStoredSecret={provider?.hasClientSecret ?? false}
          />

          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="pri"
            disabled={save.isPending}
            aria-busy={save.isPending || undefined}
          >
            {editing ? "Save changes" : "Add the provider"}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
