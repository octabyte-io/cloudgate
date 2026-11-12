import { useMutation } from "@tanstack/react-query";

import {
  cloudAccountsApi,
  type ConnectCloudAccountInput,
  type ConnectGoogleCloudAccountInput,
  type UpdateCloudAccountInput,
  type UpdateGoogleCloudAccountInput,
} from "@/lib/api/endpoints/cloud-accounts";
import { useInvalidate } from "@/lib/api/use-invalidate";

/** The setup template for an account about to be connected. Keeps nothing. */
export function useCloudAccountSetup() {
  return useMutation({
    mutationFn: (body: { cloudId: string; setupToken?: string }) =>
      cloudAccountsApi.setup(body),
  });
}

/** The setup script for a Google Cloud project about to be connected. Keeps nothing. */
export function useGoogleCloudAccountSetup() {
  return useMutation({
    mutationFn: (body: { cloudId: string; setupToken?: string }) =>
      cloudAccountsApi.setupGoogle(body),
  });
}

/** Connects one, through its cloud's connect check. */
export function useConnectCloudAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (
      body: ConnectCloudAccountInput | ConnectGoogleCloudAccountInput,
    ) => cloudAccountsApi.create(body),
    onSettled: () => invalidate.cloudAccounts(),
  });
}

/**
 * Edits one; a changed key or role ARN — or, on Google Cloud, provider or
 * service account — is checked before anything is saved.
 */
export function useUpdateCloudAccount(id: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (
      body: UpdateCloudAccountInput | UpdateGoogleCloudAccountInput,
    ) => cloudAccountsApi.update(id, body),
    onSettled: () => invalidate.cloudAccounts(),
  });
}

/** "Check now": reruns the connect check and records how it ended. */
export function useCheckCloudAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => cloudAccountsApi.check(id),
    onSettled: () => invalidate.cloudAccounts(),
  });
}

/** The current setup template for a connected one. Keeps nothing. */
export function useCloudAccountTemplate() {
  return useMutation({
    mutationFn: (id: string) => cloudAccountsApi.template(id),
  });
}

/** A connected Google Cloud account's current setup script. Keeps nothing. */
export function useGoogleCloudAccountTemplate() {
  return useMutation({
    mutationFn: (id: string) => cloudAccountsApi.googleTemplate(id),
  });
}

/** "New key": a pending key pair; nothing signs with it yet. */
export function useNewCloudAccountKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => cloudAccountsApi.newKey(id),
    onSettled: () => invalidate.cloudAccounts(),
  });
}

/** The check signed with the pending key; a pass switches to it. */
export function useCheckNewCloudAccountKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => cloudAccountsApi.checkNewKey(id),
    onSettled: () => invalidate.cloudAccounts(),
  });
}

/** Removes Cloudgate's row; what is in the cloud stays. */
export function useDeleteCloudAccount() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => cloudAccountsApi.remove(id),
    onSettled: () => invalidate.cloudAccounts(),
  });
}
