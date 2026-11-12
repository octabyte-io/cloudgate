"use client";

import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { TabPending } from "@/components/console/tab-pending";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { kindRefusals } from "../config-kind";
import {
  usePreviewDeployments,
  usePreviewMutations,
} from "../advanced/use-advanced";
import { useApplication, useUpdateApplication } from "../use-application";
import { PreviewListCard } from "./previews-list-card";
import { PreviewSettingsCard } from "./previews-settings-card";
import { RequestedPreviewsCard } from "./requested-previews-card";

/**
 * Copies of this Application on hosts of their own: one per open pull
 * request, and one per request an Agent or a deployer made (ADR-0026).
 *
 * The order is the argument: the **settings** come first because the limits
 * on them decide whether either kind should be on at all
 * and the two
 * **lists** below are what those limits count — **Pull-request previews** and
 * **Requested previews**, one card per trigger so each card's "every slot is
 * taken" speaks for its own limit and no preview is listed twice.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const application = useApplication(id);
  const previews = usePreviewDeployments(id);
  const mutations = usePreviewMutations(id);

  const row = application.data;
  const update = useUpdateApplication(id, row?.environmentId);

  if (!row) return <TabPending />;

  // A web-private has no previews, nor does a worker; the tab
  // says why rather than offering switches the API refuses.
  const refused = kindRefusals(row.configKind)?.previews ?? null;
  if (refused !== null) {
    return (
      <Page className="grid gap-3">
        <PageHeader title={label} icon={icon} />
        <MetaStrip>{refused}</MetaStrip>
      </Page>
    );
  }

  return (
    <Page className="grid gap-3">
      <PageHeader
        title={label}
        icon={icon}
        lede="A running copy of this Application on its own host, per open pull request or per request made for a branch."
      />

      <PreviewSettingsCard row={row} update={update} />

      <PreviewListCard
        previews={previews}
        mutations={mutations}
        active={row.isPreviewDeploymentsActive}
        limit={row.previewLimit}
      />

      <RequestedPreviewsCard
        applicationId={id}
        previews={previews}
        mutations={mutations}
        allowed={row.requestedPreviewsAllowed}
        limit={row.requestedPreviewLimit}
      />
    </Page>
  );
}
