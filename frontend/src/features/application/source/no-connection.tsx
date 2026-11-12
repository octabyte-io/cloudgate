import Link from "next/link";

import { Icon } from "@/lib/design/icons";
import { settingsHref } from "@/lib/settings/sections";

import type { GitProviderSpec } from "./providers";

/**
 * This provider has no connection yet, so there is nothing to pick from.
 *
 * Deliberately **not** an `EmptyState`: that one carries the control that makes
 * the first one, and connecting a git provider is an OAuth round trip on a screen
 * F15 owns — a button here would either go nowhere or start a flow this panel
 * cannot finish. So it says what is missing and where it is done, which is the
 * same shape F08's `NoListing` takes for a missing endpoint.
 *
 * **"Where it is done" is a link**.
 * The argument above is against a control that *starts* the connection; a link
 * to the screen that does neither goes nowhere nor starts a flow here. Without
 * it "under Settings" meant leaving an Application page — whose rail has no
 * Settings entry — by a route nothing named.
 *
 * It is not an error either. Nobody did anything wrong; there is simply one step
 * that happens once per Organization and has not happened.
 */
export function NoConnection({ spec }: { spec: GitProviderSpec }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-info-line bg-info-tint px-3.5 py-3">
      <Icon name="info" className="mt-0.5 flex-none text-info" />
      <div className="min-w-0 text-body text-tx">
        <p className="font-medium">
          No {spec.label} account is connected to this Organization.
        </p>
        <p className="mt-1 text-meta text-tx-2">
          Cloudgate clones through a connected account, so there is nothing to
          choose from until one exists. Connect {spec.label} under{" "}
          <Link
            href={settingsHref("git-providers")}
            className="font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
          >
            Settings → Git providers
          </Link>
          , then come back and pick a {spec.noun}.
        </p>
      </div>
    </div>
  );
}
