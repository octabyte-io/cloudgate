import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ScopePanel } from "@/components/shell/scope-panel";
import { tabScreen } from "@/components/shell/nav";

/**
 * Every tab of Project scope, on one optional catch-all. See
 * `applications/[applicationId]/[[...tab]]/page.tsx` for why there is one route
 * file per scope and where the tab list comes from.
 */
type Props = { params: Promise<{ projectId: string; tab?: string[] }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { tab } = await params;
  // An invented tab is about to 404 (`notFound()` below), so it is titled as
  // one — not after this scope's noun, which put "Project · Cloudgate" over
  // "That page is not here.". The database route does the same.
  return {
    title: tabScreen("project", (tab ?? []).join("/"))?.label ?? "Not found",
  };
}

export default async function Page({ params }: Props) {
  const { tab } = await params;
  if (!tabScreen("project", (tab ?? []).join("/"))) notFound();

  return <ScopePanel />;
}
