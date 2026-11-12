"use client";

import { ServiceShell } from "@/features/service-shell/service-shell";
import { applicationShellService } from "@/features/service-shell/shell-services";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useApplication } from "../use-application";

/**
 * An Application's **Shell** tab: `sh` in one of its running
 * containers. The tab is absent in a Cloud account and for a role without
 * `service:update` (`tabs/application.ts`); the body is shared with the
 * database and Compose scopes (`features/service-shell`).
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const row = application.data;

  return (
    <ServiceShell
      label={label}
      icon={icon}
      error={application.error}
      pending={application.isPending}
      service={row ? applicationShellService(row) : null}
    />
  );
}
