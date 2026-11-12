"use client";

import { useBrandingOrDefault } from "@/lib/api/use-branding";

import { Wordmark } from "./wordmark";

/**
 * The mark as this instance brands it: the operator's name and logo
 * when they set them, ours when they did not.
 *
 * An entry point because the auth layout — a Server Component — renders it,
 * and the masthead reads the same query. Both layouts seed the branding from
 * the server, so this draws the right mark on the first paint and changes the
 * moment the Branding screen saves.
 */
export function BrandMark({ wordClassName }: { wordClassName?: string }) {
  const branding = useBrandingOrDefault();
  return (
    <Wordmark
      wordClassName={wordClassName}
      name={branding.appName}
      logoUrl={branding.logoUrl}
    />
  );
}
