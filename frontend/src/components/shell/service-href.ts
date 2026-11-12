import { databaseHref } from "@/components/shell/scope";
import type { ServiceType } from "@/lib/api/endpoints/applications";

/**
 * Where a service in this Environment lives, given only its kind and id.
 *
 * Extracted from the Services tab when the Deployments and Domains tabs became
 * real tables and
 * needed the same answer: all three now list a mixed set of the eight kinds, and
 * all three link each row to the service's own screen. Promoted out of
 * `features/environment/` under §1.4 when the Overview's health fact line
 * (`components/console/service-health-state.tsx`) became its second
 * importer; beside `scope.ts`, whose `databaseHref` it builds on.
 *
 * The kind is load-bearing rather than cosmetic. A database's address carries its
 * engine (`components/shell/scope.ts` says why), the other two are flat — which
 * is exactly the knowledge a caller holding a `serviceId` and a `serviceType`
 * should not have to hold as well.
 */
export function serviceHref(service: {
  serviceType: ServiceType;
  serviceId: string;
}): string {
  switch (service.serviceType) {
    case "application":
      return `/applications/${service.serviceId}`;
    case "compose":
      return `/compose/${service.serviceId}`;
    // A bucket's page is not a tab scope: it has one view.
    case "bucket":
      return `/buckets/${service.serviceId}`;
    default:
      return databaseHref(service.serviceType, service.serviceId);
  }
}

/**
 * A service's own tab of the same name, for a row that gathers something the
 * service owns — its Deployments, its domains.
 *
 * **Only the two deployable kinds have those tabs** (`tabs/application.ts`,
 * `tabs/compose.ts`); a managed database's scope has no Deployments and no
 * Domains row, because nothing routes to one and its deploy writes no
 * `deployment` record. A database *does* appear in the Deployments feed — a
 * backup or volume-backup run of one is recorded — so for those the link goes to
 * the service itself rather than to a tab that would 404.
 */
export function serviceTabHref(
  service: { serviceType: ServiceType; serviceId: string },
  tab: "deployments" | "domains",
): string {
  const base = serviceHref(service);
  return service.serviceType === "application" ||
    service.serviceType === "compose"
    ? `${base}/${tab}`
    : base;
}
