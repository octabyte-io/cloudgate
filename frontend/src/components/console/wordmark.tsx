import { cn } from "@/lib/utils";

import { CloudgateGlyph } from "./cloudgate-glyph";

/**
 * The mark: the glyph and the logotype, at their one size.
 *
 * A fragment rather than an element, because its two callers put it in different
 * rows — the masthead's Organization cell (F05) and the auth screens' centred
 * column (F06) — and a wrapper here would mean fighting it in both.
 *
 * **Nothing scales it.** `text-mark` exists precisely because a logotype is set
 * once, to its own measurements (15px / 650 / −0.28px — see the type table in
 * `frontend/docs/design-system.md`); a door with a bigger wordmark than the
 * console's is two marks. `wordClassName` is for hiding the word, which is the
 * only thing the masthead needs at the 60px icon strip — not for restyling it.
 *
 * **A white-labelled instance brings its own**: `name` replaces the
 * logotype and `logoUrl` the glyph, at the glyph's size, so a rebranded mark
 * sits in exactly the space ours does. Both come from `BrandMark`, which reads
 * the branding; this stays a plain component so the reading is done once, in
 * one place.
 *
 * **The fallback is the logotype, not `PRODUCT_NAME`.** Ours is set lowercase
 * — `cloudgate` — where the product's name in a sentence or a title is
 * `Cloudgate`; the one is a drawing of the other, so they are two strings.
 */
export function Wordmark({
  wordClassName,
  name,
  logoUrl,
}: {
  wordClassName?: string;
  /** The operator's product name, set as they typed it. */
  name?: string | null;
  /** An http(s) URL or root-relative path, already checked by `normalizeBranding`. */
  logoUrl?: string | null;
}) {
  return (
    <>
      {logoUrl ? (
        // A plain `<img>`, not `next/image`: the logo is an operator's URL on
        // any host, and `next/image` would need each host in `remotePatterns`
        // at build time. Decorative — the link around the mark is what is named.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logoUrl} alt="" className="size-5 flex-none object-contain" />
      ) : (
        <CloudgateGlyph size={20} className="text-brand-tx" />
      )}
      <span className={cn("text-mark text-tx", wordClassName)}>
        {name ?? "cloudgate"}
      </span>
    </>
  );
}
