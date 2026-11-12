import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { DOCK_INIT_SCRIPT } from "@/components/shell/dock-state";
import { RAIL_INIT_SCRIPT } from "@/components/shell/rail-state";

import { Providers } from "./providers";
import "./globals.css";

// These set the CSS variables that globals.css's --font-sans / --font-mono
// theme keys read. next/font downloads both at build time and serves them from
// our own origin, so no request reaches Google from a visitor's browser.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Cloudgate",
    template: "%s · Cloudgate",
  },
  description:
    "Deploy and operate applications, databases and servers from one console.",
  /**
   * Declared here, from `public/`, rather than as `app/favicon.ico`. A
   * file-convention favicon outranks every layout's metadata and is put first
   * in the list whatever a nested layout says, so a white-labelled instance's
   * favicon would have been the *second* icon in `<head>` — and which of two a
   * browser shows is the browser's call. Declared, it is one `icons` field that
   * the auth and console layouts replace when the branding sets one.
   */
  icons: { icon: "/favicon.ico" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning: next-themes writes the theme class onto <html>
    // before paint, so the server's markup and the client's first render
    // legitimately differ on this one element.
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
    >
      {/* The rail's collapsed state, written onto <html> before first paint
          (`rail-state.ts`). Here rather than in the console layout: this
          layout is never re-rendered on the client, so React never has to
          *create* the element there — which it refuses to run, and logs
          "Encountered a script tag" about, whenever a client navigation or a
          hydration fallback mounted the console layout afresh. On a door it
          sets an attribute nothing reads. */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: RAIL_INIT_SCRIPT }} />
        {/* The docked terminal's height and minimised/maximised view, the
            same way and for the same reason (`dock-state.ts`). */}
        <script dangerouslySetInnerHTML={{ __html: DOCK_INIT_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
