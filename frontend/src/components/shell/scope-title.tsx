import { useEffect, useRef, useState } from "react";

import { PRODUCT_NAME } from "@/lib/branding/branding";

import { tabScreen } from "./nav";
import type { Recent } from "./recents";
import type { ScopeContext } from "./scope-provider";

/**
 * `ui-main / production / storefront` — the identity as one line of text, for
 * the places that cannot hold links: a Recents row, a tooltip, a tab title.
 */
export function scopePathLabel(
  identity: NonNullable<ScopeContext["identity"]>,
): string {
  return [...(identity.parents ?? []).map((each) => each.name), identity.name]
    .join(" / ");
}

/**
 * A resolved scope as a row of this browser's lists — what Recents records and,
 * with its Organization, what a star is (`starOf`). One builder, so the
 * two lists can never label or nest the same resource differently.
 */
export function visitOf(
  identity: NonNullable<ScopeContext["identity"]>,
  href: string,
): Recent {
  return {
    id: identity.id,
    label: scopePathLabel(identity),
    href,
    ancestors: identity.parents?.map((each) => each.id),
  };
}

/**
 * A resource scope's document title names the resource, not only the tab.
 *
 * The route's `generateMetadata` only has the URL, so every Project's Settings
 * was `Settings · Cloudgate` — two browser tabs, or two history entries, for two
 * Projects read the same — and a Project that is not there was titled after its
 * default tab, `Environments · Cloudgate`, over "That Project is not here".
 *
 * **Client-side, from the identity the masthead already resolved**, rather than
 * a fetch in `generateMetadata`: nothing under the console fetches on the server
 * (`(console)/layout.tsx`), and it would be a second request for a name this
 * shell has already paid for. The route's own title stands until the name
 * arrives, which is the tab label — right, just less specific.
 *
 * `null` while there is nothing better to say than the route: still pending, a
 * refusal that is not a 404, or a tab this scope does not have — that page is
 * `(console)/not-found.tsx`, and each `[[...tab]]/page.tsx`'s `generateMetadata`
 * titles it "Not found".
 */
export function scopeDocumentTitle(
  value: ScopeContext,
  /** The instance's name — the operator's on a white-labelled one. */
  product: string = PRODUCT_NAME,
): string | null {
  if (value.scope.kind === "organization") return null;
  if (value.missing) return `Not found · ${product}`;
  if (!value.identity) return null;
  const tab = tabScreen(value.scope.kind, value.scope.tab);
  if (!tab) return null;
  return `${tab.label} · ${scopePathLabel(value.identity)} · ${product}`;
}

/**
 * React 19's hoisted `<title>`, the same mechanism `app/not-found.tsx` uses.
 *
 * **Why the `generation` key.** React puts a newly *mounted* `<title>` first in
 * `<head>`, and the first one is the document's title — so whichever mounted
 * last wins. Next's metadata `<title>` can mount after this one: metadata
 * streams in behind a Suspense boundary, so on a tab change it may land a
 * commit later. Rejected: writing `document.title` from an effect, which writes
 * into *Next's* element behind React's back — React then believes its text is
 * unchanged, and leaving the scope for a page with the same route title (a
 * Project's Settings → the Organization's Settings) kept the Project's name.
 * Here the element is React's own and leaves with this component; the observer
 * only notices when some other title has been put in front of it, and remounts
 * it so it is in front again.
 */
export function ScopeDocumentTitle({ title }: { title: string }) {
  const [generation, setGeneration] = useState(0);
  const own = useRef<HTMLTitleElement>(null);

  useEffect(() => {
    const observer = new MutationObserver(() => {
      const first = document.head.querySelector("title");
      if (own.current && first !== own.current) {
        setGeneration((each) => each + 1);
      }
    });
    observer.observe(document.head, { childList: true });
    return () => observer.disconnect();
  }, []);

  return (
    <title key={`${title}#${generation}`} ref={own}>
      {title}
    </title>
  );
}
