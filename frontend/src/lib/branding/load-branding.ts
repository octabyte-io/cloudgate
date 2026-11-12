import { dehydrate, QueryClient } from "@tanstack/react-query";
import { connection } from "next/server";
import { cache } from "react";

import { keys } from "@/lib/api/keys";

import type { Branding } from "./branding";
import { fetchBranding } from "./fetch-branding";

/**
 * The branding for this request, fetched once however many places ask.
 *
 * A layout asks twice — its `generateMetadata` and its body — and React's
 * `cache` makes that one request per render.
 *
 * `connection()` first, and **outside** `fetchBranding`'s `try`: the branding is
 * per-instance and changes at runtime, so a prerendered sign-in page would
 * carry whatever the build machine's backend said, which is nothing. Letting a
 * `no-store` fetch opt the route out instead would mean Next's internal
 * bail-out error travelling through a `catch` that exists to swallow errors.
 */
export const loadBranding = cache(async (): Promise<Branding> => {
  await connection();
  return fetchBranding();
});

/**
 * The server's answer, handed to the client's query cache so `useBranding()`
 * starts with it instead of fetching it again and drawing the unbranded mark
 * until it lands. TanStack's own server-rendering seam
 * (`HydrationBoundary`), not a context of ours.
 */
export function brandingState(branding: Branding) {
  const client = new QueryClient();
  client.setQueryData(keys.branding(), branding);
  return dehydrate(client);
}
