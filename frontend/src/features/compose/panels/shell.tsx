"use client";

import { ServiceShell } from "@/features/service-shell/service-shell";
import { composeShellService } from "@/features/service-shell/shell-services";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useCompose } from "../use-compose";

/**
 * A Compose stack's **Shell** tab: `sh` in one of the stack's running
 * containers, picked by its compose service (`docker-compose` and `stack`
 * alike). Absent for a role without `service:update` (`tabs/compose.ts`).
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const compose = useCompose(id);
  const row = compose.data;

  return (
    <ServiceShell
      label={label}
      icon={icon}
      error={compose.error}
      pending={compose.isPending}
      service={row ? composeShellService(row) : null}
    />
  );
}
