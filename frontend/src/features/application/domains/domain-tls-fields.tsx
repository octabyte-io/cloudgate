import Link from "next/link";
import { useState } from "react";
import { Controller, useFormContext } from "react-hook-form";

import { Field } from "@/components/console/field";
import { Segmented } from "@/components/console/segmented";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { CertificateType } from "@/lib/api/endpoints/domains";
import { settingsHref } from "@/lib/settings/sections";

import type { DomainValues } from "./domain-schema";
import { example } from "@/components/console/form-spec";

/** Where stored certificates live, as a link — the hints below name it three times. */
function CertificatesLink() {
  return (
    <Link
      href={settingsHref("certificates")}
      className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
    >
      Settings → Certificates
    </Link>
  );
}

/**
 * What the selected choice does, under the control. It used to read
 * "Let's Encrypt issues one…" whichever was picked.
 *
 * The resolver choices both say a stored certificate wins, because it does:
 * Traefik serves a certificate from its store that covers the host before it
 * asks a resolver, which is what the Domains table's Certificate column shows.
 */
const CERTIFICATE_HINT: Record<CertificateType, React.ReactNode> = {
  none: "Nothing here manages a certificate, and HTTPS needs one. For a host behind a CDN or proxy that terminates TLS itself, turn HTTPS off instead.",
  letsencrypt: (
    <>
      Let&apos;s Encrypt issues one automatically once DNS points here. A
      certificate in <CertificatesLink /> that covers this host is served
      instead.
    </>
  ),
  custom: (
    <>
      A certificate resolver configured on the Server&apos;s Traefik issues it.
      A certificate in <CertificatesLink /> that covers this host is served
      instead.
    </>
  ),
  stored: (
    <>
      Traefik serves the certificate in <CertificatesLink /> whose names cover
      this host — a wildcard counts. Add it there first; a host none covers is
      refused.
    </>
  ),
};

/**
 * What the Certificate control says while HTTPS is off. It used to show
 * the None hint, which told the operator to turn off the HTTPS that was off.
 */
const HTTPS_OFF_HINT =
  "HTTPS is off, so no certificate is served. Turn HTTPS on to choose where one comes from.";

/**
 * HTTPS, who supplies the certificate, and the resolver field that only one of
 * those answers needs.
 *
 * **HTTPS off is certificate None**. The dialog took HTTPS off with
 * Let's Encrypt, and the row then read "HTTP / Let's Encrypt" for a host that
 * serves no certificate. So turning HTTPS off sets None, and the Certificate
 * control is off until HTTPS is on again; a stored domain saved that way
 * opens showing None, and the dialog sends None for it.
 *
 * The three are one group because they are one decision, and the state that decides
 * which field is on screen belongs to it rather than to the dialog: nothing else in
 * the form reads it.
 */
export function DomainTlsFields({
  certificateType,
}: {
  /** The stored answer, for a domain being edited. */
  certificateType: CertificateType;
}) {
  const form = useFormContext<DomainValues>();
  const https = form.watch("https");
  const [certificate, setCertificate] =
    useState<CertificateType>(certificateType);
  const shown = https ? certificate : "none";

  return (
    <>
      <Field
        name="https"
        label="Serve over HTTPS"
        hint="Traefik redirects HTTP to HTTPS and terminates TLS."
        orientation="horizontal"
        manual
      >
        <Controller
          name="https"
          control={form.control}
          render={({ field }) => (
            <Switch
              checked={field.value}
              onCheckedChange={(next) => {
                field.onChange(next);
                // HTTPS with no issuer is the backend's first refusal, so
                // turning it on picks the answer almost everyone wants and
                // leaves it visible to change.
                if (next && certificate === "none") {
                  setCertificate("letsencrypt");
                  form.setValue("certificateType", "letsencrypt");
                }
                if (!next) {
                  setCertificate("none");
                  form.setValue("certificateType", "none");
                }
              }}
            />
          )}
        />
      </Field>

      <Field
        name="certificateType"
        label="Certificate"
        hint={https ? CERTIFICATE_HINT[certificate] : HTTPS_OFF_HINT}
        manual
      >
        <Controller
          name="certificateType"
          control={form.control}
          render={({ field }) => (
            <Segmented<CertificateType>
              label="Certificate"
              // Four choices outgrow a phone-width dialog on one line.
              className="h-auto flex-wrap"
              value={https ? field.value : "none"}
              disabled={!https}
              onChange={(next) => {
                field.onChange(next);
                setCertificate(next);
              }}
              options={[
                { value: "none", label: "None" },
                { value: "letsencrypt", label: "Let's Encrypt" },
                { value: "stored", label: "Stored certificate" },
                { value: "custom", label: "Custom resolver" },
              ]}
            />
          )}
        />
      </Field>

      {shown === "custom" ? (
        <Field
          name="customCertResolver"
          label="Traefik resolver"
          // Revealed by the choice above: it arrives rather than appears.
          className="animate-rise"
          hint="The name of a certificate resolver configured on the Server."
        >
          <Input
            placeholder={example("myresolver")}
            autoComplete="off"
            spellCheck={false}
            className="font-mono text-meta md:text-meta"
          />
        </Field>
      ) : null}
    </>
  );
}
