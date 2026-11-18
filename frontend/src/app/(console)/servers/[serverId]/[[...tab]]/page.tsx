import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { ScopePanel } from "@/components/shell/scope-panel";
import { tabScreen } from "@/components/shell/nav";

/**
 * Every tab of Server scope, on one optional catch-all. See
 * `applications/[applicationId]/[[...tab]]/page.tsx` for why there is one route
 * file per scope and where the tab list comes from.
 */
type Props = { params: Promise<{ serverId: string; tab?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tab } = await params;
  // An invented tab is about to 404 (`notFound()` below), so it is titled as
  // one — not after this scope's noun, which put "Project · Cloudgate" over
  // "That page is not here.". The database route does the same.
  return { title: tabScreen("server", (tab ?? []).join("/"))?.label ?? "Not found" };
}

export default async function Page({ params }: Props) {
  const { serverId, tab } = await params;
  // The Shell tab was called Terminal, at `terminal`, until the console settled
  // on one word for an interactive session (CONTEXT.md, **Shell tab**). The old
  // address was every other Server tab's "Open a shell" link, so it is in
  // bookmarks and history; it forwards rather than 404s.
  if (tab?.length === 1 && tab[0] === "terminal") {
    permanentRedirect(`/servers/${encodeURIComponent(serverId)}/shell`);
  }
  if (!tabScreen("server", (tab ?? []).join("/"))) notFound();

  return <ScopePanel />;
}
