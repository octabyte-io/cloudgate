import { Field } from "@/components/console/field";
import { Input } from "@/components/ui/input";
import { example } from "@/components/console/form-spec";

/**
 * The OIDC half of a provider, which the backend takes **whole or not at all**.
 *
 * Its own component because that is a real seam rather than a line count:
 * `ssoProviderBodySchema` types `oidcConfig` optional and `clientSecret`
 * required *inside* it, so every field here moves together — change one and the
 * secret has to be resent. Splitting it out of the dialog makes the group that
 * behaves as a unit look like one.
 *
 * The endpoints are genuinely optional: driven against a real registration,
 * `registerSSOProvider` writes a `discoveryEndpoint` derived from the issuer, so
 * a provider serving `/.well-known/openid-configuration` needs none of them —
 * once its origin is trusted, which is the gate the dialog above explains.
 */
export function OidcFields({
  values,
  set,
  editing,
  oidcTouched,
  hasStoredSecret,
}: {
  values: {
    clientId: string;
    clientSecret: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    userInfoEndpoint: string;
    jwksEndpoint: string;
    scopes: string;
  };
  set: (key: keyof typeof values, next: string) => void;
  editing: boolean;
  oidcTouched: boolean;
  hasStoredSecret: boolean;
}) {
  return (
    <>
      <div className="border-t border-line pt-4">
        <p className="text-ui font-medium text-tx">OIDC client</p>
        <p className="mt-0.5 text-meta text-tx-2">
          {editing ? (
            <>
              Leave the secret blank and change nothing here to keep the stored
              configuration. Change any of it and the secret has to be sent again
              — the backend takes this block whole or not at all, and the console
              does not keep a copy of your secret.
            </>
          ) : (
            <>
              The endpoints are optional: with none of them set, the provider is
              discovered at{" "}
              <code className="font-mono">
                &lt;issuer&gt;/.well-known/openid-configuration
              </code>
              .
            </>
          )}
        </p>
      </div>

      <Field name="clientId" label="Client id">
        <Input
          value={values.clientId}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => set("clientId", event.target.value)}
        />
      </Field>

      <Field
        name="clientSecret"
        label="Client secret"
        optional={editing && !oidcTouched}
        hint={
          editing
            ? hasStoredSecret
              ? "A secret is stored. It is never sent back to this screen."
              : "No secret is stored for this provider."
            : undefined
        }
      >
        <Input
          value={values.clientSecret}
          type="password"
          autoComplete="new-password"
          onChange={(event) => set("clientSecret", event.target.value)}
        />
      </Field>

      <div className="grid gap-3.5 sm:grid-cols-2">
        {ENDPOINTS.map(({ key, label }) => (
          <Field key={key} name={key} label={label} optional>
            <Input
              value={values[key]}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => set(key, event.target.value)}
            />
          </Field>
        ))}
      </div>

      <Field
        name="scopes"
        label="Scopes"
        optional
        hint="Comma separated. Left empty, the provider's own defaults apply."
      >
        <Input
          value={values.scopes}
          autoComplete="off"
          spellCheck={false}
          placeholder={example("openid, email, profile")}
          onChange={(event) => set("scopes", event.target.value)}
        />
      </Field>
    </>
  );
}

const ENDPOINTS = [
  { key: "authorizationEndpoint", label: "Authorization endpoint" },
  { key: "tokenEndpoint", label: "Token endpoint" },
  { key: "userInfoEndpoint", label: "User info endpoint" },
  { key: "jwksEndpoint", label: "JWKS endpoint" },
] as const;
