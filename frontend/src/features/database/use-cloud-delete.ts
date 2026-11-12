import { useMutation, useQuery } from "@tanstack/react-query";

import { useForgetVisited } from "@/components/shell/recents";
import { databasesApi } from "@/lib/api/endpoints/databases";
import type { DatabaseKind } from "@/lib/api/endpoints/databases";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The final snapshot a cloud database's Delete pressed now keeps, for its
 * Delete dialog: read only while the dialog is open, fresh each time,
 * since it is named for today.
 */
export function useFinalSnapshot(
  kind: DatabaseKind,
  databaseId: string,
  enabled: boolean,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.databases.finalSnapshot(organizationId, kind, databaseId),
    queryFn: () => databasesApi.finalSnapshot(kind, databaseId),
    enabled: enabled && organizationId !== null && databaseId !== "",
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/** Retry and Forget of a cloud database's incomplete Delete (ADR-0038). */
export function useDatabaseCloudDeleteActions(
  kind: DatabaseKind,
  databaseId: string,
  environmentId: string,
) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  return {
    retry: useMutation({
      mutationFn: () => databasesApi.retryCloudDelete(kind, databaseId),
      onSettled: () => invalidate.database({ kind, databaseId, environmentId }),
    }),
    forget: useMutation({
      mutationFn: () => databasesApi.forgetCloudDelete(kind, databaseId),
      onSuccess: () => {
        forgetVisited([databaseId]);
        return invalidate.environment({ environmentId });
      },
    }),
  };
}
