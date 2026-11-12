import { useMutation } from "@tanstack/react-query";

import {
  sshKeysApi,
  type CreateSshKeyInput,
  type UpdateSshKeyInput,
} from "@/lib/api/endpoints/ssh-keys";
import { useInvalidate } from "@/lib/api/use-invalidate";

/**
 * Adding, renaming and removing an SSH key.
 *
 * The **read** is `lib/api/use-ssh-keys.ts` — three features pick from that list,
 * so it belongs to none of them — and re-exported here so a screen in this folder
 * has one import.
 *
 * Every one of these invalidates the **Servers** as well as the keys, and that is
 * the interesting part rather than housekeeping: `server.sshKeyId` is
 * `onDelete: 'set null'`, so deleting a key silently leaves every Server that used
 * it with no key at all. The fleet's key column and each Server's Access tab are
 * reading that column, and after a delete they are both wrong until they refetch.
 */

export { useSshKeys } from "@/lib/api/use-ssh-keys";

export function useCreateSshKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateSshKeyInput) => sshKeysApi.create(input),
    onSuccess: () => invalidate.sshKeys(),
  });
}

/** Name and description only. The keypair itself cannot be changed. */
export function useUpdateSshKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { sshKeyId: string; input: UpdateSshKeyInput }) =>
      sshKeysApi.update(args.sshKeyId, args.input),
    onSuccess: () => invalidate.sshKeys(),
  });
}

export function useDeleteSshKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (sshKeyId: string) => sshKeysApi.remove(sshKeyId),
    onSuccess: () => invalidate.sshKeys(),
  });
}
