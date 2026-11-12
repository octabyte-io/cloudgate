"use client";

import { QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";

import { ThemeProvider } from "@/components/console/theme-provider";
import { Toaster } from "@/components/console/toast";
import { makeQueryClient } from "@/lib/api/query-client";

/**
 * Everything the app needs in context, mounted once in the root layout.
 *
 * The `QueryClient` is held in state rather than created at module scope: a
 * module-level client would be shared across requests on the server, which is
 * one browser's cache leaking into another's render. One client per mount, and
 * `useState` keeps it across re-renders.
 *
 * The session is not a provider — better-auth's `useSession` reads a store the
 * auth client owns (`src/lib/auth/client.ts`), so any component can call it
 * without one.
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(makeQueryClient);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        {children}
        {/* One host for the whole app (F03). `toast()` is how anything
            reaches it; nothing renders a second Toaster. */}
        {/* A toast that names something — "Deleted <name>." — wraps a long
            name anywhere rather than running out of its box.
            `cn-toast` is `ui/sonner.tsx`'s own, restated because these
            options replace its `toastOptions` rather than merging. */}
        <Toaster
          position="bottom-right"
          closeButton
          toastOptions={{
            classNames: {
              toast: "cn-toast",
              title: "wrap-anywhere",
              description: "wrap-anywhere",
            },
          }}
        />
      </ThemeProvider>
    </QueryClientProvider>
  );
}
