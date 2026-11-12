import { z } from "zod";

import type { CertificateType } from "@/lib/api/endpoints/domains";
import { hostnameField } from "@/lib/forms/hostname";

/**
 * The backend's path rule, copied from the DTO the same way (`pathSchema` in
 * `domains/dto/domain.dto.ts`): a leading slash, then RFC 3986 path
 * characters minus the two that mean something to a Traefik label — a backtick
 * ends the ``PathPrefix(`…`)`` argument, and a comma appends to the
 * `stripprefix.prefixes` slice.
 *
 * **This field's message was already making a promise the code did not keep.**
 * "A path starts with /." sat on a `min(1)` that accepted `api`, which the
 * backend also accepted and Traefik then dropped as an invalid rule — the
 * domain silently never routed. The sentence is unchanged; a later fix made it
 * true on both sides.
 */
const PATH = /^\/(?:[A-Za-z0-9\-._~!$&'()*+;=:@/]|%[0-9A-Fa-f]{2})*$/;

/**
 * What a Traefik certificate-resolver name may be, copied from the DTO
 * (`traefikNameSchema`): letters, numbers, `_` and `-`. A `.` is out
 * because it is Traefik's label-key separator, and a `,` and an `=` because
 * they split a slice and truncate a Docker label key.
 *
 * Checked only when the box is non-empty: empty is the "no custom resolver"
 * state, and the rule about *presence* is the `superRefine` below — the same
 * division the backend makes between this charset and `refineDomainRules`.
 */
const TRAEFIK_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The form's rules, as a function of one thing: whether this domain has to name a
 * compose service.
 *
 * A schema rather than a constant because zod strips keys it does not know, so an
 * optional extra field cannot be bolted on beside a fixed one — it would be
 * validated, filled in, and then quietly dropped on the way to the endpoint.
 */
export function schemaFor(withService: boolean) {
  return z
    .object({
      serviceName: withService
        ? z
            .string()
            .trim()
            .min(1, "Name the service in the compose file this host reaches.")
        : z.string(),
      host: hostnameField({
        example: "api.example.com",
        empty: "Add a hostname.",
      }),
      port: z.coerce
        .number()
        .int("A port is a whole number.")
        .min(1, "A port is between 1 and 65535.")
        .max(65535, "A port is between 1 and 65535."),
      path: z
        .string()
        .trim()
        .min(1, "A path starts with /.")
        .max(255, "A path is at most 255 characters.")
        .regex(
          PATH,
          "A path starts with / — then letters, numbers and - . _ ~ ! $ & ' ( ) * + ; = : @, with %-escapes for anything else.",
        ),
      stripPath: z.boolean(),
      https: z.boolean(),
      certificateType: z.enum(["none", "letsencrypt", "custom", "stored"]),
      customCertResolver: z
        .string()
        .trim()
        .refine((value) => value === "" || TRAEFIK_NAME.test(value), {
          message:
            "Use only letters, numbers, underscores and hyphens — letsencrypt.",
        }),
    })
    // The three cross-field rules the backend refuses on, checked here so the
    // refusal lands on the field that caused it rather than in a toast.
    .superRefine((values, ctx) => {
      if (values.https && values.certificateType === "none") {
        ctx.addIssue({
          code: "custom",
          path: ["certificateType"],
          message: "Choose where the certificate comes from, or turn HTTPS off.",
        });
      }
      if (
        values.https &&
        values.certificateType === "custom" &&
        values.customCertResolver === ""
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["customCertResolver"],
          message: "Name the Traefik resolver that issues it.",
        });
      }
      if (values.stripPath && (values.path === "" || values.path === "/")) {
        ctx.addIssue({
          code: "custom",
          path: ["stripPath"],
          message: "There is nothing to strip from /. Set a path first.",
        });
      }
    });
}

/** What the dialog's fields hold, and what its field groups read from context. */
export type DomainValues = z.infer<ReturnType<typeof schemaFor>>;

/** Everything both routes take. The parent id is the caller's business. */
export type DomainBody = {
  host: string;
  port: number;
  path: string;
  stripPath: boolean;
  https: boolean;
  certificateType: CertificateType;
  customCertResolver: string | null;
  serviceName?: string;
};

/**
 * The service list a compose domain picks from, and its three states.
 *
 * `undefined` names means the list could not be read — for a git-sourced stack
 * that is the *normal* state until it has been deployed once, since the route
 * `cat`s the clone. The field falls back to a text box there rather than a picker
 * with nothing in it, because a name typed from the repository is a perfectly good
 * answer and an empty picker is a dead end.
 */
export type ServiceChoice = {
  names: string[] | undefined;
  pending: boolean;
};
