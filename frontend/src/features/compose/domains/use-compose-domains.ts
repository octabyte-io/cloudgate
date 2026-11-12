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
 * A Compose stack's domains.
 *
 * The same four calls F09 makes for an Application, against the same controller —
 * kept as its own module rather than a parameter on that one because the *parent*
 * is what every call is keyed by, and threading "which kind of parent" through
 * four hooks to save twelve lines would make both harder to read than either.
 *
 * **`domainType: "compose"` and a `serviceName` are what make it a compose
 * domain**, and the second one is the interesting half: an Application has one
 * container to route to, and a stack has several, so a host here is meaningless
 * until it says which service inside the file it reaches.
 */

export function useComposeDomains(composeId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.domains.byCompose(organizationId, composeId),
    queryFn: () => domainsApi.byCompose(composeId),
    enabled: organizationId !== null && composeId !== "",
  });
}

export function useCreateComposeDomain(composeId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (
      input: Omit<CreateDomainInput, "composeId" | "domainType">,
    ) =>
      domainsApi.create({ ...input, composeId, domainType: "compose" }),
    onSuccess: () => invalidate.domains({ composeId }),
  });
}

export function useUpdateComposeDomain(composeId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      domainId,
      input,
    }: {
      domainId: string;
      input: UpdateDomainInput;
    }) => domainsApi.update(domainId, input),
    onSuccess: () => invalidate.domains({ composeId }),
  });
}

export function useDeleteComposeDomain(composeId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (domainId: string) => domainsApi.remove(domainId),
    onSuccess: () => invalidate.domains({ composeId }),
  });
}
