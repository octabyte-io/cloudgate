"use client";

import { useBrandingOrDefault } from "@/lib/api/use-branding";
import { brandingCss } from "@/lib/branding/branding";

/**
 * The instance's colours and, inside the console, its custom CSS.
 *
 * ## Where custom CSS applies, and where it deliberately does not
 *
 * **The console shell — every signed-in page — and nowhere else.** The auth
 * layout renders this with `customCss={false}`, so the sign-in, sign-up,
 * two-step, reset and invitation screens take the name, the logo, the favicon
 * and the two colours, and never the operator's stylesheet. Those screens hold
 * a password field, and CSS is enough to attack one without a line of script:
 * an attribute selector plus `url()` reads a controlled input's value out a
 * character at a time, and a `position: fixed` overlay can put a look-alike
 * form over the real one. `UpdateWhitelabelingDto`'s note names both as "the
 * renderer's", and this is the renderer's answer — the risk lives on the one
 * surface an anonymous visitor types a secret into, so that surface does not
 * load it. Somebody who can save this CSS can already rewrite the console's own
 * router file, so it is not an escalation inside the console; on the door it
 * would be a way to phish every other Organization's members.
 *
 * The root `not-found.tsx` sits outside both layouts and renders this itself,
 * with `customCss={false}`: it is reached with no session, so it is a door.
 * `/dev/*` takes neither.
 *
 * ## Why a `<style>` element and not a stylesheet link
 *
 * It re-renders with the query, so a save on the Branding screen repaints the
 * console without a reload. `normalizeBranding` has already refused any CSS
 * containing `</` — the only way out of a `<style>` element's raw text — and
 * the colours are interpolated only after matching the hex pattern.
 */
export function BrandingStyle({ customCss }: { customCss: boolean }) {
  const css = brandingCss(useBrandingOrDefault(), { customCss });
  return css ? <style>{css}</style> : null;
}
