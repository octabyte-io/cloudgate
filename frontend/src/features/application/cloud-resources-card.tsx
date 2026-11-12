import { useState } from "react";

import { Card } from "@/components/console/card";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import {
  cloudNameOf,
  type ApplicationDetail,
} from "@/lib/api/endpoints/applications";
import { errorMessage } from "@/lib/api/error-message";
import { usePermission } from "@/lib/auth/use-permission";

import {
  CloudResourceTable,
  RebuildStateModal,
  UnreadableStateBanner,
} from "@/components/console/cloud-resource-list";
import {
  SERVICE_REBUILD_REFUSAL,
  useRebuildServiceState,
  useServiceCloudResources,
} from "@/lib/api/use-cloud-resources";

/**
 * What Cloudgate made in AWS for a cloud Service
 * (ADR-0036
 * item 3): read from its Infrastructure state, each resource's type, AWS
 * id, region and tags, and what a tag search cannot find; on Google Cloud
 * each one's
 * Google name and labels, and what carries none of Cloudgate's. When Cloudgate
 * cannot read the state, the banner says so and offers Rebuild from the
 * cloud, `service: update`, confirmed by the Service's name.
 *
 * Renders nothing for a Service on a Server or the platform host.
 */
export function CloudResourcesCard({
  application,
}: {
  application: ApplicationDetail;
}) {
  const cloud = application.cloudPlace !== null;
  const list = useServiceCloudResources(application.applicationId, cloud);
  const permission = usePermission({ service: ["update"] });
  const rebuild = useRebuildServiceState(
    application.applicationId,
    application.environmentId,
  );
  const [rebuilding, setRebuilding] = useState(false);
  if (!application.cloudPlace) return null;
  const kind = application.cloudPlace.cloud ?? "aws";
  const where = cloudNameOf(application.cloudPlace);

  const data = list.data;
  return (
    <Card className={data && !data.readable ? "border-bad-line" : undefined}>
      <Card.Header
        title={`Made in ${where}`}
        sub="What Cloudgate made for this Service, read from its Infrastructure state. A setting’s value is never shown."
        headingLevel={2}
      />
      <Card.Body className="flex flex-col gap-3">
        {list.error ? (
          <p className="text-body text-tx-2">{errorMessage(list.error)}</p>
        ) : !data ? (
          <div className="grid gap-2.5" aria-busy="true">
            <Skeleton className="h-row" />
            <Skeleton className="h-row" />
          </div>
        ) : (
          <>
            {!data.readable ? (
              <UnreadableStateBanner
                cloud={kind}
                failure={data.failure}
                allowed={permission.allowed}
                refusal={SERVICE_REBUILD_REFUSAL}
                onRebuild={() => setRebuilding(true)}
              />
            ) : null}
            <CloudResourceTable
              list={data}
              label={`What Cloudgate made in ${where} for ${application.name}`}
            />
          </>
        )}
      </Card.Body>
      <RebuildStateModal
        cloud={kind}
        open={rebuilding}
        onOpenChange={setRebuilding}
        confirmWord={application.name}
        mismatch="That does not match the Service’s name."
        onConfirm={async () => {
          await rebuild.mutateAsync(application.name);
          setRebuilding(false);
          toast.done(`Discarded the state of ${application.name}.`, {
            description:
              kind === "gcp"
                ? "The Environment’s plan is reading Google Cloud, to take back what the names Cloudgate gave find."
                : "The Environment’s plan is reading AWS, to take back what Cloudgate’s tags find.",
          });
        }}
      />
    </Card>
  );
}
