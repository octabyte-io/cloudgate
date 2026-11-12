import type { SsoProvider, SsoProviderInput } from "@/lib/api/endpoints/sso";

/** Every field the dialog holds, all of them as typed text. */
export type ProviderFormValues = {
  providerId: string;
  issuer: string;
  domains: string;
  clientId: string;
  clientSecret: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userInfoEndpoint: string;
  jwksEndpoint: string;
  scopes: string;
};

/** The stored provider as text, or empty for a registration. */
export function initialValues(provider?: SsoProvider): ProviderFormValues {
  return {
    providerId: provider?.providerId ?? "",
    issuer: provider?.issuer ?? "",
    domains: provider?.domains.join(", ") ?? "",
    clientId: provider?.oidcConfig?.clientId ?? "",
    // Never prefilled: the console deletes the secret at the client boundary
    // so it has none
    // to resend.
    clientSecret: "",
    authorizationEndpoint: provider?.oidcConfig?.authorizationEndpoint ?? "",
    tokenEndpoint: provider?.oidcConfig?.tokenEndpoint ?? "",
    userInfoEndpoint: provider?.oidcConfig?.userInfoEndpoint ?? "",
    jwksEndpoint: provider?.oidcConfig?.jwksEndpoint ?? "",
    scopes: provider?.oidcConfig?.scopes?.join(", ") ?? "",
  };
}

/**
 * Whether the OIDC block is being sent at all.
 *
 * On a create it always is. On an edit it is sent only when something in it has
 * changed — which is what makes "leave the secret blank to keep it" a real option
 * rather than a hint that leads to a refusal. `ssoProviderBodySchema` types
 * `oidcConfig` as optional and `clientSecret` as **required inside it**, so the
 * block goes whole or not at all.
 */
export function oidcTouched(
  values: ProviderFormValues,
  provider?: SsoProvider,
): boolean {
  const stored = provider?.oidcConfig;
  return (
    !provider ||
    values.clientSecret.trim() !== "" ||
    values.clientId !== (stored?.clientId ?? "") ||
    values.authorizationEndpoint !== (stored?.authorizationEndpoint ?? "") ||
    values.tokenEndpoint !== (stored?.tokenEndpoint ?? "") ||
    values.userInfoEndpoint !== (stored?.userInfoEndpoint ?? "") ||
    values.jwksEndpoint !== (stored?.jwksEndpoint ?? "") ||
    values.scopes !== (stored?.scopes?.join(", ") ?? "")
  );
}

/** What goes on the wire, with the OIDC block included only when it is being set. */
export function buildProviderInput(
  values: ProviderFormValues,
  withOidc: boolean,
): SsoProviderInput {
  return {
    providerId: values.providerId.trim(),
    issuer: values.issuer.trim(),
    domains: splitList(values.domains),
    ...(withOidc
      ? {
          oidcConfig: {
            clientId: values.clientId.trim(),
            clientSecret: values.clientSecret.trim(),
            ...optional("authorizationEndpoint", values.authorizationEndpoint),
            ...optional("tokenEndpoint", values.tokenEndpoint),
            ...optional("userInfoEndpoint", values.userInfoEndpoint),
            ...optional("jwksEndpoint", values.jwksEndpoint),
            ...(splitList(values.scopes).length > 0
              ? { scopes: splitList(values.scopes) }
              : {}),
          },
        }
      : {}),
  };
}

/** A comma-separated field as a list, with the blanks dropped. */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * An optional URL field, present only when it holds something.
 *
 * `z.string().url()` refuses `""`, so sending an empty optional is a 400 on a
 * field the person deliberately left blank — F10's second defect in its other
 * form. Omitted is the only correct way to say "not set" here.
 */
function optional(key: string, value: string): Record<string, string> {
  const trimmed = value.trim();
  return trimmed ? { [key]: trimmed } : {};
}
