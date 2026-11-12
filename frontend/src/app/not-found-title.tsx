"use client";

import { ScopeDocumentTitle } from "@/components/shell/scope-title";

/**
 * The root 404's tab title, kept in front of the root layout's metadata
 * `<title>` ("Cloudgate"), which otherwise comes first in `<head>` and is the
 * one the browser shows — a white-labelled instance's 404 tab read "Cloudgate".
 * `ScopeDocumentTitle` is the component that keeps its own `<title>`
 * first; this file is only the client boundary the server `not-found` needs.
 */
export function NotFoundTitle({ title }: { title: string }) {
  return <ScopeDocumentTitle title={title} />;
}
