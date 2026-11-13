import { z } from "zod";

import { SettingsCard } from "@/components/console/settings-card";

import { hostnameField } from "@/lib/forms/hostname";

import { ConsoleOriginRemedy, LiveScreensCaveat } from "./console-origin-remedy";
import { useInstanceGate, usePlatformMutations } from "./use-platform";

/**
 * Point the console at a hostname.
 *
 * The form is four fields because the route takes four, and the interesting one
 * is the **empty host**: clearing it makes `updateServerTraefik` call
 * `removeConfig('cloudgate')`, which deletes `dynamic/cloudgate.yml`. That is a
 * real action rather than a blank field, so the footer says it rather than
 * leaving somebody to find out by pressing Save on a form they were only
 * looking at.
 *
 * **The notice above the fields is the other thing a save does not do**
 * Saving writes
 * the routers and Traefik issues a real certificate, so the console is served
 * on the new name over HTTPS — and every sign-in there is refused
 * `403 INVALID_ORIGIN` until the backend trusts that origin, which a stock
 * install deliberately does not. Trusting it on save was rejected for the
 * installer's reason: a trusted origin whose `CLOUDGATE_API_URL` was never
 * changed signs the operator in to a console whose live screens are dead, and
 * this form cannot see whether that change and its restart happened. So the
 * card says both halves before the save, and the Console routing card below
 * reports whether the saved domain's origin is trusted yet.
 */
export function AssignDomainCard({
  host,
  https,
  certificateType,
  letsEncryptEmail,
}: {
  host: string | null;
  https: boolean;
  certificateType: "letsencrypt" | "none" | "custom";
  letsEncryptEmail: string | null;
}) {
  const mutations = usePlatformMutations();
  // `POST /settings/assign-domain` takes instance authority (ADR-0013).
  const gate = useInstanceGate();

  const schema = z
    .object({
      // No `empty` sentence, because an empty box is not a malformed host
      // here: it is the "no console domain" state the footer describes, and
      // the backend admits it for the same reason. `max(255)` is this card's
      // own and predates the rule — the route has no length limit, so it is
      // the one thing this field is stricter about than the endpoint it posts
      // to.
      host: hostnameField({ example: "console.example.com" }).max(255),
      https: z.boolean(),
      certificateType: z.enum(["none", "letsencrypt", "custom"]),
      letsEncryptEmail: z.union([
        z.email("That is not an email address."),
        z.literal(""),
      ]),
    })
    .refine(
      (values) =>
        values.certificateType !== "letsencrypt" ||
        values.letsEncryptEmail !== "",
      {
        error: "Let's Encrypt needs an address to send expiry warnings to.",
        path: ["letsEncryptEmail"],
      },
    )
    .refine((values) => !values.https || values.certificateType !== "none", {
      error: "HTTPS with no issuer has nothing to serve a certificate from.",
      path: ["certificateType"],
    });

  return (
    <SettingsCard
      gate={gate}
      title="Console domain"
      lede="The hostname this console is served on, and how its certificate is issued."
      schema={schema}
      fields={(values) => [
        {
          kind: "text",
          name: "host",
          label: "Host",
          optional: true,
          mono: true,
          placeholder: "console.example.com",
          hint: signInOrigin(values)
            ? `Point a DNS record at this machine first. Browsers signing in there send the origin ${signInOrigin(values)}.`
            : "Point a DNS record at this machine first. Leaving it empty removes the router.",
        },
        { kind: "switch", name: "https", label: "Serve it over HTTPS" },
        {
          kind: "select",
          name: "certificateType",
          label: "Certificate",
          options: [
            { value: "none", label: "None" },
            { value: "letsencrypt", label: "Let's Encrypt" },
            { value: "custom", label: "One of your own certificates" },
          ],
          hint:
            values.certificateType === "custom"
              ? "Traefik picks a matching certificate from the ones on the Certificates screen."
              : undefined,
        },
        {
          kind: "text",
          name: "letsEncryptEmail",
          label: "Let's Encrypt email",
          when: (current) => current.certificateType === "letsencrypt",
          hint: "Where expiry warnings go. Stored in Traefik's ACME configuration.",
        },
      ]}
      defaultValues={{
        host: host ?? "",
        https,
        certificateType,
        letsEncryptEmail: letsEncryptEmail ?? "",
      }}
      submit={(values) =>
        mutations.assignDomain.mutateAsync({
          host: values.host,
          https: values.https,
          certificateType: values.certificateType,
          letsEncryptEmail:
            values.letsEncryptEmail === "" ? null : values.letsEncryptEmail,
        })
      }
      savedMessage="The console's domain is saved."
      footer="Saving rewrites dynamic/cloudgate.yml, which Traefik picks up within seconds. Saving with the host empty deletes that file, and the console stops being served on a name."
    >
      <div className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx">
        <p>
          <strong className="font-semibold">
            Nobody can sign in on this domain until the backend trusts its
            origin
          </strong>{" "}
          — and saving does not add it. The console is served there, over HTTPS
          if you ask for it, and every sign-in is refused.{" "}
          <ConsoleOriginRemedy origin="the domain's origin" />
        </p>
        <p className="mt-1.5 text-tx-2">
          <LiveScreensCaveat />
        </p>
      </div>
    </SettingsCard>
  );
}

/**
 * The origin a browser on the typed host sends — scheme and host, no port,
 * because the routers sit on Traefik's 80 and 443. `undefined` while the box
 * holds nothing a URL can be made of, so the hint never shows a half-typed
 * origin as fact.
 */
function signInOrigin(values: {
  host: string;
  https: boolean;
}): string | undefined {
  const host = values.host.trim();
  if (!host) return undefined;
  try {
    return new URL(`${values.https ? "https" : "http"}://${host}`).origin;
  } catch {
    return undefined;
  }
}
