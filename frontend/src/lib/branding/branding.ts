import type { Metadata } from "next";

import type { WhitelabelingConfig } from "@/lib/api/endpoints/whitelabeling";

/**
 * **What the stored branding does to the console, as pure functions**.
 *
 * Everything that renders the branding — the two layouts' metadata, the
 * masthead and sign-in mark, the style block, the error pages — goes through
 * here, so "what counts as set" is decided once.
 *
 * **The backend already validates every field** (`UpdateWhitelabelingDto`:
 * http(s) or root-relative URLs, hex colours, no `</` in the CSS). This checks
 * again anyway, because the read is `@Public()` and its answer lands in
 * `<link href>`, `<img src>` and a `<style>` body on a page that takes a
 * password: a row written before a rule existed, or by hand in the database,
 * must not be the thing that proves the rule was load-bearing. A value that
 * fails here is treated as unset, not rendered.
 */

export type Branding = WhitelabelingConfig;

/** The product's own name, for everything an unbranded instance shows. */
export const PRODUCT_NAME = "Cloudgate";

export const UNBRANDED: Branding = {
  appName: null,
  logoUrl: null,
  faviconUrl: null,
  primaryColor: null,
  accentColor: null,
  customCss: null,
  errorPages: {
    notFoundMessage: null,
    serverErrorMessage: null,
    supportUrl: null,
  },
};

/** The backend's `brandingUrl` rule: an http(s) URL or a root-relative path. */
export const BRANDING_URL = /^(https?:\/\/|\/)/;
/** The backend's `hexColor` rule, the form a colour picker emits. */
export const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function url(value: unknown): string | null {
  const candidate = text(value);
  return candidate && BRANDING_URL.test(candidate) ? candidate : null;
}

function color(value: unknown): string | null {
  const candidate = text(value);
  return candidate && HEX_COLOR.test(candidate) ? candidate : null;
}

/**
 * Whatever came back from `GET /settings/whitelabeling`, as a `Branding` whose
 * every field is either usable or `null`.
 *
 * Custom CSS is not trimmed — whitespace is harmless there — but it is dropped
 * whole if it holds `</`, the one sequence that ends a `<style>` element.
 */
export function normalizeBranding(raw: unknown): Branding {
  if (!raw || typeof raw !== "object") return UNBRANDED;
  const row = raw as Record<string, unknown>;
  const pages =
    row.errorPages && typeof row.errorPages === "object"
      ? (row.errorPages as Record<string, unknown>)
      : {};
  const css =
    typeof row.customCss === "string" &&
    row.customCss.trim() !== "" &&
    !row.customCss.includes("</")
      ? row.customCss
      : null;

  return {
    appName: text(row.appName),
    logoUrl: url(row.logoUrl),
    faviconUrl: url(row.faviconUrl),
    primaryColor: color(row.primaryColor),
    accentColor: color(row.accentColor),
    customCss: css,
    errorPages: {
      notFoundMessage: text(pages.notFoundMessage),
      serverErrorMessage: text(pages.serverErrorMessage),
      supportUrl: url(pages.supportUrl),
    },
  };
}

/** The name this instance goes by: the operator's, or ours. */
export function brandName(branding: Branding | null | undefined): string {
  return branding?.appName ?? PRODUCT_NAME;
}

/**
 * A page title as the templates write it — `"<title> · <app name>"` — for the
 * two pages no branded template reaches: `/`, which sits in the console
 * layout's own segment (a template applies to the segments *under* its
 * layout), and the root `not-found`, which sits under no layout but the root.
 */
export function brandedTitle(
  title: string,
  branding: Branding | null | undefined,
): string {
  return `${title} · ${brandName(branding)}`;
}

/**
 * The document title and favicon a layout declares.
 *
 * Empty when nothing relevant is set, so the root layout's own
 * `"%s · Cloudgate"` and `/favicon.ico` stand. `icons` **replaces** the
 * parent's rather than adding to it — Next resolves metadata one field at a
 * time — which is why the default favicon is declared in the root layout's
 * metadata rather than as `app/favicon.ico`: a file-convention favicon is put
 * first in the list whatever a nested layout says, and a tab showing two
 * candidate icons picks one by rules we do not control.
 */
export function brandingMetadata(branding: Branding): Metadata {
  const metadata: Metadata = {};
  if (branding.appName) {
    metadata.title = {
      default: branding.appName,
      template: `%s · ${branding.appName}`,
    };
  }
  if (branding.faviconUrl) metadata.icons = { icon: branding.faviconUrl };
  return metadata;
}

/**
 * The `<style>` body for this instance's branding, or `""` for none.
 *
 * **Colours.** `primaryColor` is the filled brand surface — the primary
 * button, the first chart series, the focus ring. `accentColor` is brand
 * *text* — links, the mark, the info tone and its tint — and falls back to the
 * primary when unset, so setting one colour does not leave the console in two
 * brands. `:root:root` rather than `:root` so it outranks `.dark` on the same
 * element: one colour in both themes, which is what an operator typing one hex
 * value asked for. Contrast against white text and both grounds is theirs to
 * choose; the form says so.
 *
 * **Custom CSS** is appended only where the caller asks for it. The console
 * shell does; the sign-in screens do not — see `BrandingStyle`.
 */
export function brandingCss(
  branding: Branding,
  { customCss }: { customCss: boolean },
): string {
  const rules: string[] = [];
  const primary = branding.primaryColor;
  const accent = branding.accentColor ?? primary;

  if (primary) {
    rules.push(
      `:root:root{--brand:${primary};--brand-hi:color-mix(in oklab,${primary} 86%,black);--brand-ring:${primary};}`,
    );
  }
  if (accent) {
    rules.push(
      `:root:root{--brand-tx:${accent};--brand-tint:color-mix(in oklab,${accent} 12%,var(--panel));--brand-line:color-mix(in oklab,${accent} 45%,var(--panel));}`,
    );
  }
  if (customCss && branding.customCss) rules.push(branding.customCss);

  return rules.join("\n");
}
