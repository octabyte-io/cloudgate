"use client";

import { useSeesPlatformHost } from "./use-sees-platform-host";

/**
 * A platform host's page, opened by its address. For a reader not shown those
 * pages — a customer on the Hosted instance (ADR-0053) — it is one plain
 * sentence instead of a screen of disabled cards, and nothing beneath it is
 * mounted, so nothing is fetched. While the answer is on its way it renders
 * nothing, so neither the cards nor the sentence flash. Each is a settings
 * section, already inside `SettingsPage`, so the sentence needs no page of its
 * own.
 */
export function PlatformHostGate({ children }: { children: React.ReactNode }) {
  const { sees, pending } = useSeesPlatformHost();
  if (pending) return null;
  if (!sees) {
    return (
      <p className="text-body text-tx-2">
        This page is for the owners and admins of the Instance organization.
      </p>
    );
  }
  return children;
}
