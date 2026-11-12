import type { Deployment } from "@/lib/api/endpoints/deployments";
import type { MetricsConfig, Server } from "@/lib/api/endpoints/servers";
import type { ServiceRow } from "@/components/console/rows/service-row";

/**
 * Rows the product really holds, for the gallery at `/dev/rows`.
 *
 * The awkward cases are the point, because they are what a row shape has to
 * survive: a description long enough to want the whole column, a service with no
 * domain and no branch, a Deployment that is still queued and so has no duration
 * at all, and one that was cancelled between two that succeeded.
 *
 * Times are relative to whenever the page loads, so the "When" column is always
 * exercising `timeAgo`'s branches rather than showing five dates from the day the
 * fixture was written.
 */

const METRICS: MetricsConfig = {
  server: {
    type: "Remote",
    refreshRate: 60,
    port: 4500,
    token: "",
    urlCallback: "",
    retentionDays: 7,
    cronJob: "",
    thresholds: { cpu: 0, memory: 0 },
  },
  containers: { refreshRate: 60, services: { include: [], exclude: [] } },
};

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SERVERS: Server[] = [
  {
    serverId: "srv-prod-1",
    name: "swarm-prod-1",
    description: "Swarm manager. Runs the storefront and the payments API.",
    ipAddress: "203.0.113.24",
    port: 22,
    username: "root",
    serverStatus: "active",
    serverType: "deploy",
    command: "",
    enableDockerCleanup: true,
    requestMetricsEnabled: false,
    reachCheckedAt: null,
    reachOk: null,
    reachMessage: null,
    setupRanAt: null,
    setupOk: null,
    setupMessage: null,
    sshKeyId: "key-1",
    hostKeyFingerprint: null,
    maintenanceSince: null,
    maintenanceStartedBy: null,
    metricsConfig: METRICS,
    createdAt: ago(94 * DAY),
    organizationId: "org-1",
    boughtServer: null,
  },
  {
    serverId: "srv-build-1",
    name: "builder-eu-1",
    description: null,
    ipAddress: "198.51.100.9",
    port: 2222,
    username: "cloudgate",
    serverStatus: "active",
    serverType: "build",
    command: "",
    enableDockerCleanup: false,
    requestMetricsEnabled: false,
    reachCheckedAt: null,
    reachOk: null,
    reachMessage: null,
    setupRanAt: null,
    setupOk: null,
    setupMessage: null,
    sshKeyId: "key-2",
    hostKeyFingerprint: null,
    maintenanceSince: null,
    maintenanceStartedBy: null,
    metricsConfig: METRICS,
    createdAt: ago(9 * DAY),
    organizationId: "org-1",
    boughtServer: null,
  },
  {
    serverId: "srv-old-1",
    name: "swarm-staging-2",
    description:
      "Retired after the staging environments moved onto swarm-prod-1. Kept for the volume backups until the end of the quarter.",
    ipAddress: "192.0.2.77",
    port: 22,
    username: "root",
    serverStatus: "inactive",
    serverType: "deploy",
    command: "",
    enableDockerCleanup: false,
    requestMetricsEnabled: false,
    reachCheckedAt: null,
    reachOk: null,
    reachMessage: null,
    setupRanAt: null,
    setupOk: null,
    setupMessage: null,
    sshKeyId: null,
    hostKeyFingerprint: null,
    maintenanceSince: null,
    maintenanceStartedBy: null,
    metricsConfig: METRICS,
    createdAt: ago(3 * HOUR),
    organizationId: "org-1",
    boughtServer: null,
  },
];

export const SERVICES: ServiceRow[] = [
  {
    id: "app-store",
    kind: "application",
    name: "storefront-web",
    appName: "storefront-web-8f2a1c",
    status: "done",
    href: "/applications/app-store",
    source: "main",
    domain: "shop.example.com",
    replicas: 3,
    lastDeployedAt: ago(14 * MINUTE),
  },
  {
    id: "app-api",
    kind: "application",
    name: "payments-api",
    appName: "payments-api-3c90de",
    status: "error",
    href: "/applications/app-api",
    source: "release/2026.08",
    domain: "api.example.com",
    replicas: 2,
    lastDeployedAt: ago(2 * HOUR),
  },
  {
    id: "db-main",
    kind: "postgres",
    name: "storefront-db",
    appName: "postgres-storefront-db-71ad04",
    status: "running",
    href: "/databases/postgres/db-main",
    source: null,
    domain: null,
    replicas: 1,
    lastDeployedAt: null,
  },
  {
    id: "db-cache",
    kind: "redis",
    name: "session-cache",
    appName: "redis-session-cache-0b41f7",
    status: "running",
    href: "/databases/redis/db-cache",
    source: null,
    domain: null,
    replicas: 1,
    lastDeployedAt: null,
  },
  {
    id: "cmp-obs",
    kind: "compose",
    name: "observability",
    appName: "compose-observability-5d2e88",
    status: "done",
    href: "/compose/cmp-obs",
    source: "main",
    domain: "grafana.example.com",
    replicas: null,
    lastDeployedAt: ago(5 * DAY),
  },
  {
    id: "app-jobs",
    kind: "application",
    name: "worker-jobs",
    appName: "worker-jobs-2ab6c1",
    status: "idle",
    href: "/applications/app-jobs",
    source: "ghcr.io/example/worker:2026.08.1",
    domain: null,
    replicas: 4,
    lastDeployedAt: ago(31 * DAY),
  },
];

export const DEPLOYMENTS: Deployment[] = [
  {
    deploymentId: "dep-1",
    title: "Manual deployment",
    description: "9f21c4e — raise the checkout timeout",
    status: "running",
    logPath: "/etc/cloudgate/logs/dep-1.log",
    applicationId: "app-store",
    composeId: null,
    backupId: null,
    volumeBackupId: null,
    scheduleId: null,
    createdAt: ago(3 * MINUTE),
    startedAt: ago(2 * MINUTE),
    finishedAt: null,
  },
  {
    deploymentId: "dep-2",
    title: "Push to main",
    description: "2f9c1ab — bump the base image",
    status: "done",
    logPath: "/etc/cloudgate/logs/dep-2.log",
    applicationId: "app-store",
    composeId: null,
    backupId: null,
    volumeBackupId: null,
    scheduleId: null,
    createdAt: ago(52 * MINUTE),
    startedAt: ago(52 * MINUTE),
    finishedAt: ago(50 * MINUTE + 12_000),
  },
  {
    deploymentId: "dep-3",
    title: "Queued deployment",
    description: null,
    status: "pending",
    logPath: "",
    applicationId: "app-api",
    composeId: null,
    backupId: null,
    volumeBackupId: null,
    scheduleId: null,
    createdAt: ago(30_000),
    startedAt: null,
    finishedAt: null,
  },
  {
    deploymentId: "dep-4",
    title: "Push to release/2026.08",
    description: "8d13e70 — retry the webhook signature check",
    status: "error",
    logPath: "/etc/cloudgate/logs/dep-4.log",
    applicationId: "app-api",
    composeId: null,
    backupId: null,
    volumeBackupId: null,
    scheduleId: null,
    createdAt: ago(2 * HOUR),
    startedAt: ago(2 * HOUR),
    finishedAt: ago(2 * HOUR - 41_000),
  },
  {
    deploymentId: "dep-5",
    title: "Manual deployment",
    description: "superseded by 9f21c4e",
    status: "cancelled",
    logPath: "",
    applicationId: null,
    composeId: "cmp-obs",
    backupId: null,
    volumeBackupId: null,
    scheduleId: null,
    createdAt: ago(5 * DAY),
    startedAt: ago(5 * DAY),
    finishedAt: ago(5 * DAY - 3_000),
  },
];

/** Which service a Deployment deployed — the join a real screen already has. */
export function ownerOf(deployment: Deployment) {
  const service = SERVICES.find(
    (each) =>
      each.id === deployment.applicationId || each.id === deployment.composeId,
  );
  return service
    ? { label: service.name, href: service.href, path: "storefront / production" }
    : null;
}
