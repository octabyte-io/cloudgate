import { SettingsCard } from "@/components/console/settings-card";
import { useInstanceGate } from "@/features/settings/platform/use-platform";
import type { Gate } from "@/lib/auth/use-permission";
import type { Branding } from "@/lib/branding/branding";

import {
  brandingPatch,
  brandingValues,
  colorsSchema,
  customCssSchema,
  errorPagesSchema,
  identitySchema,
  type BrandingField,
} from "./branding-form";
import { useUpdateBranding } from "./use-whitelabeling";
import { example } from "@/components/console/form-spec";

/**
 * The four cards of the Branding screen, one per thing an operator
 * sets at a sitting: the name and marks, the colours, the stylesheet, the
 * error-page copy. Four saves rather than one, because the route is a merge
 * and each card sends only its own changes — see `branding-form.ts`.
 *
 * Each card is **keyed on the stored values it edits**. `useApiForm` reads
 * `defaultValues` once, and the diff a save sends is taken against them; after
 * a save the branding query refetches, the key changes, and the card starts
 * again from what is now stored rather than diffing against what used to be.
 *
 * **Every Save is off, with the reason, for a caller without instance
 * authority**: `PATCH /settings/whitelabeling` runs
 * `requireInstanceAuthority` before anything else, no statement names that,
 * and `useInstanceGate` is the read on `/settings/instance` that takes the
 * same authority. An admin of a second Organization, or a member, keeps the
 * fields to read and sees why Save is not theirs. The route's *other* check —
 * the instance organization's licence — has no read the console can ask
 * (`whitelabeling-section.tsx` says what that costs), so a caller who has the
 * authority but not that licence still meets the backend's refusal on save.
 *
 * No `"use client"`: only `whitelabeling-section.tsx` is imported by a Server
 * Component.
 */
export function BrandingCards({
  branding,
  lockedBy,
}: {
  branding: Branding;
  /**
   * A refusal that outranks instance authority — a lapsed license,
   * which keeps the saved branding on every page and refuses every edit.
   */
  lockedBy?: Gate;
}) {
  const instanceGate = useInstanceGate();
  const gate = lockedBy ?? instanceGate;
  const update = useUpdateBranding();
  const save = (values: Partial<Record<BrandingField, string>>) =>
    update.mutateAsync(brandingPatch(branding, values));
  const keyOf = (fields: readonly BrandingField[]) =>
    JSON.stringify(brandingValues(branding, fields));

  return (
    <>
      <SettingsCard
        key={keyOf(IDENTITY)}
        title="Name and marks"
        lede="What this instance calls itself, in the browser tab, the masthead and on the sign-in screen."
        schema={identitySchema}
        defaultValues={brandingValues(branding, IDENTITY)}
        submit={save}
        gate={gate}
        savedMessage="The name and marks are saved."
        fields={[
          {
            kind: "text",
            name: "appName",
            label: "Name",
            optional: true,
            placeholder: example("Cloudgate"),
            hint: "Replaces Cloudgate in the tab title, beside the mark and in the sign-in heading.",
          },
          {
            kind: "text",
            name: "logoUrl",
            label: "Logo URL",
            optional: true,
            mono: true,
            placeholder: "https://example.com/logo.svg",
            hint: "Takes the glyph's place beside the name, at the glyph's size — a square mark works best. An http(s) URL, or a path on this host starting with /.",
          },
          {
            kind: "text",
            name: "faviconUrl",
            label: "Favicon URL",
            optional: true,
            mono: true,
            placeholder: "https://example.com/favicon.png",
            hint: "The icon in the browser tab. An http(s) URL, or a path on this host starting with /.",
          },
        ]}
        footer={FOOTER}
      >
        <p className="text-body text-tx-2">
          The branding belongs to the whole instance: every Organization on it,
          and everybody who reaches its sign-in screen, sees what is saved here.
          Only an owner or admin of the instance organization can save it, and
          it is that Organization&rsquo;s license that counts.
        </p>
      </SettingsCard>

      <SettingsCard
        key={keyOf(COLORS)}
        title="Colors"
        lede="The brand color on buttons, links and highlights, in both themes."
        schema={colorsSchema}
        defaultValues={brandingValues(branding, COLORS)}
        submit={save}
        gate={gate}
        savedMessage="The colors are saved."
        fields={[
          {
            kind: "text",
            name: "primaryColor",
            label: "Primary",
            optional: true,
            mono: true,
            placeholder: "#1f6feb",
            hint: "Primary buttons, the focus ring and the first chart series. Their label is white, so choose a color dark enough to read it on.",
          },
          {
            kind: "text",
            name: "accentColor",
            label: "Accent",
            optional: true,
            mono: true,
            placeholder: "#1f6feb",
            hint: "Links, the mark and highlighted text. Left empty, it follows the primary color.",
          },
        ]}
        footer="One color serves the light and the dark theme alike, so check it against both — the console does not adjust a color you choose."
      />

      <SettingsCard
        key={keyOf(CSS)}
        title="Custom CSS"
        lede="A stylesheet of your own, loaded on every signed-in page of the console."
        schema={customCssSchema}
        defaultValues={brandingValues(branding, CSS)}
        submit={save}
        gate={gate}
        savedMessage="The custom CSS is saved."
        fields={[
          {
            kind: "textarea",
            name: "customCss",
            label: "CSS",
            optional: true,
            mono: true,
            rows: 10,
            hint: "Up to 50,000 characters. It may not contain </.",
          },
        ]}
        footer="It is not loaded on the sign-in, sign-up, two-step or password-reset screens. Those hold a password field, and a stylesheet is enough to cover one with a copy or read what is typed into it — so the doors take the name, marks and colors above, and nothing from here."
      />

      <SettingsCard
        key={keyOf(ERROR_PAGES)}
        title="Error pages"
        lede="Your wording on the console's error screens, and where to send people for help."
        schema={errorPagesSchema}
        defaultValues={brandingValues(branding, ERROR_PAGES)}
        submit={save}
        gate={gate}
        savedMessage="The error-page copy is saved."
        fields={[
          {
            kind: "textarea",
            name: "notFoundMessage",
            label: "Page not found",
            optional: true,
            rows: 2,
            hint: "Shown under “That page is not here.” in place of the stock sentence.",
          },
          {
            kind: "textarea",
            name: "serverErrorMessage",
            label: "Page failed",
            optional: true,
            rows: 2,
            hint: "Shown under “This screen could not be shown.” when a page fails to draw.",
          },
          {
            kind: "text",
            name: "supportUrl",
            label: "Support URL",
            optional: true,
            mono: true,
            placeholder: "https://example.com/support",
            hint: "Adds a “contact support” link to both screens. An http(s) URL, or a path on this host starting with /.",
          },
        ]}
        footer={FOOTER}
      />
    </>
  );
}

const IDENTITY = ["appName", "logoUrl", "faviconUrl"] as const;
const COLORS = ["primaryColor", "accentColor"] as const;
const CSS = ["customCss"] as const;
const ERROR_PAGES = [
  "notFoundMessage",
  "serverErrorMessage",
  "supportUrl",
] as const;

const FOOTER =
  "Empty a field and save to put Cloudgate's own back. Only the fields you changed are sent.";
