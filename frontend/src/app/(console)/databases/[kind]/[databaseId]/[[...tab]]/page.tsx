import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ScopePanel } from "@/components/shell/scope-panel";
import { tabScreen } from "@/components/shell/nav";
import { DATABASE_LABEL, isDatabaseKind } from "@/lib/api/endpoints/databases";

/**
 * Every tab of database scope, for all six engines.
 *
 * **The engine is in the URL, and it is not a parent id.** `GET /:id` is only
 * answerable once you know which of the six controllers to ask
 * (`endpoints/databases.ts`), and a reload has nothing but the address — so
 * `/databases/postgres/<id>` carries the engine the way a row carries its type.
 * That is the opposite of the parent ids flat routing rejects: this segment
 * cannot disagree with the row, because the row is what confirms it.
 *
 * An engine we do not have 404s here rather than opening a database rail over
 * nothing (`scope.ts` refuses it too, so the rail stays the Organization's).
 */
type Props = {
  params: Promise<{ kind: string; databaseId: string; tab?: string[] }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { kind, tab } = await params;
  const screen = tabScreen("database", (tab ?? []).join("/"))?.label;
  // An address the page is about to 404 must not be titled as though it worked:
  // `not-found.tsx` cannot export metadata, so this is the only place the tab
  // gets to say so. Found by driving `/databases/nonsense/xyz`, which showed a
  // not-found screen under a tab reading "Overview · Database".
  if (!isDatabaseKind(kind) || !screen) return { title: "Not found" };
  return { title: `${screen} · ${DATABASE_LABEL[kind]}` };
}

export default async function Page({ params }: Props) {
  const { kind, tab } = await params;
  if (!isDatabaseKind(kind)) notFound();
  if (!tabScreen("database", (tab ?? []).join("/"))) notFound();

  return <ScopePanel />;
}
