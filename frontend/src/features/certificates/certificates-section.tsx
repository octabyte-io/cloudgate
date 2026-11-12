"use client";

import { useQuery } from "@tanstack/react-query";

import { ResourceList } from "@/components/console/resource-list";
import { certificatesApi } from "@/lib/api/endpoints/certificates";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

import { certificateSpec } from "./certificates-spec";

/**
 * Certificates: one `ResourceList` and one configuration file — F15's registries
 * screen, one more time, because it is the same shape of thing.
 *
 * **Every route here is `@RequirePermission('certificate', …)`**, and
 * `certificate` is in `enterpriseOnlyResources` — which means the check is
 * *skipped* for owner, admin and member, and only bites for somebody holding a
 * custom role. So on an unlicensed instance this screen works for everybody, and
 * on a licensed one a role built without `certificate: read` gets a 403 that
 * `ResourceList` renders as a refusal rather than as an empty table. That
 * distinction is F09's first defect and it is why nothing here treats an error
 * as zero rows.
 */
export function CertificatesSection() {
  const { organizationId } = useActiveOrganizationId();
  const invalidate = useInvalidate();

  const query = useQuery({
    queryKey: keys.certificates.list(organizationId),
    queryFn: certificatesApi.list,
    enabled: organizationId !== null,
  });

  return (
    <ResourceList
      spec={certificateSpec(invalidate.certificates)}
      query={query}
    />
  );
}
