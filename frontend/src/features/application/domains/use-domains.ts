import { useMutation, useQuery } from "@tanstack/react-query";

import {
  domainsApi,
  type CreateDomainInput,
  type UpdateDomainInput,
} from "@/lib/api/endpoints/domains";
import { settingsApi } from "@/lib/api/endpoints/settings";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * An Application's domains, and the four things a screen does to them.
 *
 * `POST /domains` takes the parent id in the **body** while `PATCH` and `DELETE`
 * take the domain id in the URL and no parent at all — a domain does not move
 * between services. Every mutation therefore invalidates exactly one list, which
 * is what `invalidate.domains({ applicationId })` narrows to.
 *
 * An Application's domain is also a write to its Traefik file, so each of the
 * three mutations reads that file and Traefik's verdict on it again
 * (`invalidate.traefikConfig`). A stack's domain is not: its routers are
 * labels applied at its next Deployment, and it has no per-Application verdict.
 */

export function useApplicationDomains(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.domains.byApplication(organizationId, applicationId),
    queryFn: () => domainsApi.byApplication(applicationId),
    enabled: organizationId !== null && applicationId !== "",
  });
}

/**
 * The domain list of whichever parent a domain belongs to — the Application's or
 * the stack's, under the same key each Domains tab already reads, so a dialog
 * opened from a row of that list costs no request.
 *
 * One query choosing its key rather than two hooks with one switched off,
 * because the removal dialog is shared by both parents and only ever knows one
 * of the two ids.
 */
export function useParentDomains(parent: {
  applicationId?: string;
  composeId?: string;
  bucketId?: string;
}) {
  const { organizationId } = useActiveOrganizationId();
  const { applicationId, composeId, bucketId } = parent;
  return useQuery({
    queryKey: applicationId
      ? keys.domains.byApplication(organizationId, applicationId)
      : bucketId
        ? keys.domains.byBucket(organizationId, bucketId)
        : keys.domains.byCompose(organizationId, composeId ?? ""),
    queryFn: () =>
      applicationId
        ? domainsApi.byApplication(applicationId)
        : bucketId
          ? domainsApi.byBucket(bucketId)
          : domainsApi.byCompose(composeId ?? ""),
    enabled:
      organizationId !== null &&
      Boolean(applicationId || composeId || bucketId),
  });
}

export function useCreateDomain(applicationId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (
      input: Omit<CreateDomainInput, "applicationId" | "domainType">,
    ) =>
      domainsApi.create({
        ...input,
        applicationId,
        domainType: "application",
      }),
    onSuccess: () =>
      Promise.all([
        invalidate.domains({ applicationId }),
        invalidate.traefikConfig(applicationId),
      ]),
  });
}

export function useUpdateDomain(applicationId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: ({
      domainId,
      input,
    }: {
      domainId: string;
      input: UpdateDomainInput;
    }) => domainsApi.update(domainId, input),
    onSuccess: () =>
      Promise.all([
        invalidate.domains({ applicationId }),
        invalidate.traefikConfig(applicationId),
      ]),
  });
}

/**
 * Remove one.
 *
 * Takes **whichever parent it has** rather than an `applicationId`, because
 * `DELETE /domains/:id` carries no parent at all — the id is only ever the
 * invalidation target, and F12's stacks delete a domain through the same route and
 * the same dialog.
 */
export function useDeleteDomain(parent: {
  applicationId?: string;
  composeId?: string;
  bucketId?: string;
}) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (domainId: string) => domainsApi.remove(domainId),
    onSuccess: () =>
      Promise.all([
        invalidate.domains(parent),
        parent.applicationId
          ? invalidate.traefikConfig(parent.applicationId)
          : undefined,
      ]),
  });
}

/**
 * This Cloudgate host's own public address, for a service that has no Server
 * row to read one off.
 *
 * The dialog asks "where should this host point", and on the platform host the
 * answer is not on any `server` row — it is the one recorded in Settings →
 * Instance, which is also what `generateDomain` now writes into a generated
 * name. Without it the panel can only say it does not know, and Check DNS can
 * only say the host resolves *somewhere*.
 *
 * `keys.instanceIp()` and `settingsApi.ip` on purpose, which is exactly what
 * `settings/platform/use-platform.ts` reads: one fact about the deployment
 * under one key, so opening this dialog after visiting that screen costs no
 * request. `GET /settings/ip` is open to any authenticated user.
 *
 * Empty string is what the route answers when nothing is recorded, and callers
 * want that as "unknown" rather than as an address.
 */
export function usePlatformHostIp(enabled: boolean) {
  return useQuery({
    queryKey: keys.instanceIp(),
    queryFn: settingsApi.ip,
    enabled,
  });
}

/**
 * Ask for a host on `sslip.io` carrying the address of whatever it runs on —
 * the Server's, or this instance's own on the platform host, which refuses
 * rather than minting an addressless name when none is recorded.
 *
 * Not a query: it mints a **new** random host on every call
 * (`randomBytes(3)` in `domains.service.ts`), so calling it twice gives two
 * different answers and caching one of them would be a lie about which is current.
 * It is a mutation because pressing the button is what decides the value.
 */
export function useGenerateHost() {
  return useMutation({
    mutationFn: ({
      appName,
      serverId,
    }: {
      appName: string;
      serverId: string | null;
    }) => domainsApi.generate(appName, serverId),
  });
}

/**
 * Resolve a host and say whether it points here.
 *
 * A mutation for a different reason: it reaches DNS, so it must happen when
 * someone asks and never as a side effect of a render. Re-checking after fixing a
 * record is the whole workflow, and a cached "no" would survive the fix.
 */
export function useValidateHost() {
  return useMutation({
    mutationFn: ({ host, serverIp }: { host: string; serverIp?: string }) =>
      domainsApi.validate(host, serverIp),
  });
}

/**
 * The parent a cloud Domain hangs off: a cloud Service, or a Compose stack
 * on its Stack VM.
 */
export type CloudDomainParent =
  | { applicationId: string; composeId?: undefined }
  | { composeId: string; applicationId?: undefined };

/** Ask again: a failed cloud Domain's certificate is requested anew. */
export function useAskAgain(parent: CloudDomainParent) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (domainId: string) => domainsApi.askAgain(domainId),
    onSuccess: () => invalidate.domains(parent),
  });
}
