import { z } from "zod";

import type { WhitelabelingPatch } from "@/lib/api/endpoints/whitelabeling";
import { BRANDING_URL, HEX_COLOR, type Branding } from "@/lib/branding/branding";

/**
 * The Branding screen's forms, as data: what each field is called on
 * the wire, what a good value looks like, and what a save sends.
 *
 * **A save sends only what changed.** `PATCH /settings/whitelabeling` is a
 * merge — an absent key keeps its stored value, `null` clears it — and the
 * backend's docblock gives the reason: a whole-blob write "would have every
 * save wipe whatever another field had set". So each card diffs its own fields
 * against the branding it was opened on and sends the difference, which also
 * means two people saving two different cards do not undo each other.
 *
 * **An empty field is a clear.** Every field is nullable and null means
 * "unbranded", so emptying a field and saving puts Cloudgate's own back. There
 * is no separate Reset control to find.
 */

/** Every editable field, flattened: the three error-page keys sit beside the rest. */
export type BrandingField =
  | "appName"
  | "logoUrl"
  | "faviconUrl"
  | "primaryColor"
  | "accentColor"
  | "customCss"
  | "notFoundMessage"
  | "serverErrorMessage"
  | "supportUrl";

const ERROR_PAGE_FIELDS = new Set<BrandingField>([
  "notFoundMessage",
  "serverErrorMessage",
  "supportUrl",
]);

function stored(branding: Branding, field: BrandingField): string | null {
  return ERROR_PAGE_FIELDS.has(field)
    ? branding.errorPages[field as keyof Branding["errorPages"]]
    : (branding[field as Exclude<BrandingField, keyof Branding["errorPages"]>] ??
        null);
}

/** What a card's inputs start with: the stored value, or empty for unset. */
export function brandingValues<F extends BrandingField>(
  branding: Branding,
  fields: readonly F[],
): Record<F, string> {
  return Object.fromEntries(
    fields.map((field) => [field, stored(branding, field) ?? ""]),
  ) as Record<F, string>;
}

/**
 * The patch a card's save sends: each field whose value differs from what is
 * stored, with an empty one sent as `null`. Custom CSS keeps its whitespace;
 * everything else is trimmed, as the backend's validators would see it.
 */
export function brandingPatch(
  branding: Branding,
  values: Partial<Record<BrandingField, string>>,
): WhitelabelingPatch {
  const patch: WhitelabelingPatch = {};
  for (const [key, raw] of Object.entries(values)) {
    const field = key as BrandingField;
    const value = field === "customCss" ? (raw ?? "") : (raw ?? "").trim();
    const next = value.trim() === "" ? null : value;
    if (next === stored(branding, field)) continue;
    if (ERROR_PAGE_FIELDS.has(field)) {
      patch.errorPages = { ...patch.errorPages, [field]: next };
    } else {
      Object.assign(patch, { [field]: next });
    }
  }
  return patch;
}

const optionalUrl = z
  .string()
  .max(2048, "That is longer than any URL this accepts (2,048 characters).")
  .refine((value) => value.trim() === "" || BRANDING_URL.test(value.trim()), {
    message: "An http(s) URL, or a path on this host starting with /.",
  });

const optionalColor = z
  .string()
  .refine((value) => value.trim() === "" || HEX_COLOR.test(value.trim()), {
    message: "A hex color: # and three or six digits.",
  });

/** The backend's limits, said before the save rather than after it. */
export const identitySchema = z.object({
  appName: z.string().max(120, "120 characters at most."),
  logoUrl: optionalUrl,
  faviconUrl: optionalUrl,
});

export const colorsSchema = z.object({
  primaryColor: optionalColor,
  accentColor: optionalColor,
});

export const customCssSchema = z.object({
  customCss: z
    .string()
    .max(50_000, "50,000 characters at most.")
    .refine((value) => !value.includes("</"), {
      message:
        "Custom CSS cannot contain </ — it would end the style element it is served in.",
    }),
});

export const errorPagesSchema = z.object({
  notFoundMessage: z.string().max(500, "500 characters at most."),
  serverErrorMessage: z.string().max(500, "500 characters at most."),
  supportUrl: optionalUrl,
});
