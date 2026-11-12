import type { Metadata } from "next";

import { OrganizationHome } from "@/app/(console)/_components/home/organization-home";
import { brandedTitle } from "@/lib/branding/branding";
import { loadBranding } from "@/lib/branding/load-branding";

/**
 * `absolute`, and built here, because `/` is in the same segment as
 * `(console)/layout.tsx`: the branded `"%s · <app name>"` template it declares
 * applies to the segments under it and not to this page, so a plain
 * `"Organization home"` took the root's `"%s · Cloudgate"` on a rebranded
 * instance while every other console page took the operator's name.
 * `loadBranding` is the layout's own read, cached for the request.
 */
export async function generateMetadata(): Promise<Metadata> {
  return {
    title: {
      absolute: brandedTitle("Organization home", await loadBranding()),
    },
  };
}

export default function Page() {
  return <OrganizationHome />;
}
