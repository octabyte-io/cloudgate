import { permanentRedirect } from "next/navigation";

import { settingsHref } from "@/lib/settings/sections";

/**
 * The account screen is Settings → Account, and this address only forwards there.
 *
 * It was a "This screen is built in phase F16" placeholder that F16 never came
 * back to, because F16 built the screen under Settings instead — and the avatar
 * menu's Profile kept pointing here, so the obvious way to your own account was
 * a page saying it did not exist.
 *
 * **Kept as a redirect rather than deleted**: the menu handed this address out
 * for sixteen phases, so it is in bookmarks and history, and a 404 there would
 * be a second dead end. Permanent, because the screen moved and is not coming
 * back.
 */
export default function Page() {
  permanentRedirect(settingsHref("account"));
}
