import { useMutation, useQuery } from "@tanstack/react-query";

import {
  domainsApi,
  type CreateDomainInput,
  type UpdateDomainInput,
} from "@/lib/api/endpoints/domains";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * A Server bucket's Domains and the writes its page makes to them,
 * through the routes any Domain has: the bucket rides in the body of
 * `POST /domains` as `bucketId`, and an edit or removal names the Domain
 * alone. Each write invalidates the bucket's own list.
 */
export function useBucketDomains(bucketId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.domains.byBucket(organizationId, bucketId),
    queryFn: () => domainsApi.byBucket(bucketId),
    enabled: organizationId !== null && bucketId !== "",
  });
}

export function useCreateBucketDomain(bucketId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (
      input: Omit<
        CreateDomainInput,
        "applicationId" | "composeId" | "bucketId" | "domainType"
      >,
    ) => domainsApi.create({ ...input, bucketId }),
    onSuccess: () => invalidate.domains({ bucketId }),
  });
}

export function useUpdateBucketDomain(bucketId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      domainId,
      input,
    }: {
      domainId: string;
      input: UpdateDomainInput;
    }) => domainsApi.update(domainId, input),
    onSuccess: () => invalidate.domains({ bucketId }),
  });
}
