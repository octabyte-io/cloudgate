import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ScopePanel } from "@/components/shell/scope-panel";
import { tabScreen } from "@/components/shell/nav";

/**
 * Every tab of Application scope, on one optional catch-all.
 *
 * **One route file per scope, not one per tab.** The tab is checked against the
 * registry (`lib/shell/tab-registry.ts`) rather than against a list written
 * here, so a URL the rail does not offer 404s, and adding a tab is a line in the
 * registry and a panel file — never a new folder here. That is the seam the six
 * Wave 4 sessions build against: they own panels, F07 owns routes.
 *
 * The check happens **on the server** because that is where a 404 can still be a
 * 404: once the response is streaming, the status is already sent
 * (`03-file-conventions/loading.md`). `ScopePanel` re-reads the same pure
 * function client-side to pick the panel.
 */
type Props = { params: Promise<{ applicationId: string; tab?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tab } = await params;
  // An invented tab is about to 404 (`notFound()` below), so it is titled as
  // one — not after this scope's noun, which put "Project · Cloudgate" over
  // "That page is not here.". The database route does the same.
  return {
    title: tabScreen("application", (tab ?? []).join("/"))?.label ?? "Not found",
  };
}

export default async function Page({ params }: Props) {
  const { tab } = await params;
  if (!tabScreen("application", (tab ?? []).join("/"))) notFound();

  return <ScopePanel />;
}
