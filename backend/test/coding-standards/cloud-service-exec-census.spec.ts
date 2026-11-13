import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

/**
 * **Census: every exec site is classified for a Service in a Cloud account**
 * (ADR-0053).
 *
 * A Service in a Cloud account has `serverId: null`, and every exec
 * dispatcher reads `null` as the platform host. ADR-0053 first said work that
 * follows a Service's own place "has nowhere to land" on the host; for a cloud
 * Service it does, so a volume backup, a mount or a command schedule of one
 * ran on the shared box, as root. Nothing in the type system tells a cloud
 * Service's `null` from the host's own, so this file lists **every function in
 * `src/` that calls an exec dispatcher** (`execAsync`, `execAsyncRemote`,
 * `execRemote`, `execFileAsync`, `execOnServer`, `execOnServerStdout`,
 * `runTargetOn`, `execByServer`, `execRclone`), keyed `file#function`, each with its
 * verdict. A new one fails here until its author picks; one that went away
 * fails until its entry does.
 *
 * The verdicts:
 *
 * - **cloud-staging (allowed on the host)** — work done *for* a cloud
 *   Service on its build host, by design (ADR-0047): clone, patch apply,
 *   source upload and zip, the image pushed to its cloud, and their
 *   leftovers.
 * - **refuses a cloud Service** — the work needs the Service's own container
 *   or volume. The functions named in `guards` (the site itself when none is
 *   named) must call `refuseCloudServiceHostWork(` or ask `isCloudService(`;
 *   the test reads them for it.
 * - **a machine's own** — the id names a Server or the platform host as a
 *   machine, never a Service's place: host management under instance
 *   authority, a Server's setup, Traefik, metrics, a connection check (each
 *   refused on the Hosted host by `platform-host-census.spec.ts`), or a socket
 *   addressed by machine and container.
 * - **Cloudgate's own records** — a log Cloudgate writes, reads or ages out
 *   where it ran, and a Delete reclaiming what Cloudgate itself left under a
 *   Service's `appName`. It runs no customer program and names no customer
 *   volume or endpoint.
 * - **only a Service on a Server** — the kind has no cloud place (a Garage
 *   bucket, the engines no Cloud account runs, GPUs, an AI model), every
 *   caller forks a cloud Service away first, or the site goes to a Compose
 *   stack's run target, which reaches its own Stack VM through the cloud's
 *   tunnel (ADR-0070). A Compose stack *does* have a cloud place since
 *   ADR-0070, with `serverId: null`: a site that follows its `serverId`
 *   rather than its run target lands on the platform host and must refuse it.
 * - **open** — not yet shown to keep a cloud Service off the host. Each names
 *   the finding; the list is held exactly, so it only ever shrinks.
 *
 * Keyed by the outermost named function the call is written in (a class
 * method, a function declaration, or a `const` bound to a function), so a
 * second call in a function already classified is covered by its entry. A
 * private dispatch helper (`this.exec`) is classified for its own callers in
 * the same class; its `why` says which.
 */

const STAGING = 'cloud-staging (allowed on the host)';
const REFUSES = 'refuses a cloud Service';
const MACHINE = "a machine's own";
const RECORDS = "Cloudgate's own records";
const SERVER_ONLY = 'only a Service on a Server';
const OPEN = 'open';

type Verdict =
  | {
      readonly verdict:
        typeof STAGING | typeof MACHINE | typeof RECORDS | typeof SERVER_ONLY;
      readonly why: string;
    }
  | {
      readonly verdict: typeof REFUSES;
      /** Where the refusal is asked; the site itself when absent. */
      readonly guards?: readonly string[];
      readonly why: string;
    }
  | { readonly verdict: typeof OPEN; readonly finding: string };

const TRACES_FINDING =
  "A cloud Application's Trace store: nothing found refuses turning traces on for one, so its store container would run on its `serverId: null`, the platform host.";

const CENSUS: Readonly<Record<string, Verdict>> = {
  // --- Refuses a cloud Service -------------------------------------
  'volume-backups/volume-backups.service.ts#run': {
    verdict: REFUSES,
    why: 'The tar and the rclone copy to the customer’s endpoint; refused before the run is recorded, for a manual and a scheduled run alike.',
  },
  'volume-backups/volume-backups.service.ts#pruneOldBackups': {
    verdict: REFUSES,
    guards: ['volume-backups/volume-backups.service.ts#run'],
    why: 'Reached only from `run`, after its refusal.',
  },
  'volume-backups/volume-backups.service.ts#restore': {
    verdict: REFUSES,
    why: '`docker volume rm/create` and the untar, refused after the gates.',
  },
  'volume-backups/volume-backups.service.ts#exec': {
    verdict: REFUSES,
    guards: ['volume-backups/volume-backups.service.ts#run'],
    why: "The private dispatch, reached from `removeStagedTarball`, which only `run`'s failure path calls.",
  },
  'mounts/mounts.service.ts#writeFileMount': {
    verdict: REFUSES,
    guards: ['mounts/mounts.service.ts#refuseMountsInCloud'],
    why: "Writes the file onto the run Server; both creates and the update refuse first (`refuseMountsInCloud`), except a stack's on its own Stack VM, which goes to the stack's run target (ADR-0070).",
  },
  'mounts/mounts.service.ts#remove': {
    verdict: REFUSES,
    why: "The `rm -rf` of the file is skipped for a cloud Service, whose row still goes; a stack's on its Stack VM goes to the stack's run target.",
  },
  'scheduling/schedules/schedules.service.ts#exec': {
    verdict: REFUSES,
    guards: [
      'scheduling/schedules/schedules.service.ts#checkAccess',
      'scheduling/schedules/schedules.service.ts#resolveTarget',
      'scheduling/schedules/schedules.service.ts#remove',
    ],
    why: "The private dispatch: a create, an update and a manual run refuse in `checkAccess`, a cron run in `resolveTarget`; `remove` skips the script directory's removal. A `server` or `cloudgate-server` schedule names a machine, not a Service.",
  },

  'preview-deployments/preview-teardown.ts#previewTeardownSteps': {
    verdict: REFUSES,
    guards: ['preview-deployments/preview-teardown.ts#parentInCloud'],
    why: "A preview's `docker service rm`, route file, checkout, image and build leftovers: no step at all for a preview whose parent runs in a Cloud account, on every teardown path (the closed pull request, `DELETE`, the expiry sweep, the parent's Delete and both cascades), whose presence read (`previewServicePresence`) answers `absent` for one without asking the platform host. No such preview is made: a Requested preview's create, a rebuild, a pull request's webhook and switching previews on refuse a cloud parent (`cloud-preview.ts`), and the engine fails a preview build of one before its clone.",
  },

  'backups/backups.service.ts#run': {
    verdict: REFUSES,
    guards: ['backups/backups.service.ts#refuseCloudParent'],
    why: "A dump Backup's run, refused before it is recorded for a manual and a scheduled run alike: a cloud database (also `refuseCloudDatabaseDump` at create) and a Compose stack on its own Stack VM (ADR-0070), whose `serverId: null` reads as the platform host; and on the Hosted instance any row on the platform host. `execRclone` refuses a platform-host run on the Hosted instance whatever its caller asked.",
  },
  'backups/backups.service.ts#pruneOldBackups': {
    verdict: REFUSES,
    guards: ['backups/backups.service.ts#refuseCloudParent'],
    why: "A dump Backup's pruning, reached only from `run`, after its refusal.",
  },
  'backups/backups.service.ts#restore': {
    verdict: REFUSES,
    guards: ['backups/backups.service.ts#refuseCloudParent'],
    why: "A dump restore into a database container or a stack, refused before the Destination is read: its prelude's rclone probe runs even with no container, and its error comes back in the 400.",
  },

  // --- Cloud-staging (ADR-0047) --------------------------------------------
  'deployment-engine/deployment-engine.service.ts#exec': {
    verdict: STAGING,
    why: "The engine's dispatch to the build host: clone, patch apply, build, source zip and static publish copy for a cloud Service; the whole deploy for one on a Server. A Preview deployment's build of a cloud Application is failed before anything is dispatched (`refuseCloudPreview`): it has no cloud place, and would run on the platform host.",
  },
  'deployment-engine/deployment-engine.service.ts#pinCronImage': {
    verdict: STAGING,
    why: "Pins a Cron service's built image on its build host.",
  },
  'applications/drop-archive.ts#materializeDrop': {
    verdict: STAGING,
    why: "An uploaded source tree, written to the Service's code directory on its build host.",
  },
  'applications/drop-changes.ts#readBuildHostTree': {
    verdict: STAGING,
    why: "Hashes the Service's code directory on its build host, for an upload of only the changed files to compare against.",
  },
  'applications/drop-changes.ts#applyDropChanges': {
    verdict: STAGING,
    why: "An upload of only the changed files, applied to the Service's code directory on its build host.",
  },
  'applications/build-leftovers.ts#reclaimBuildLeftovers': {
    verdict: STAGING,
    why: "A Delete's sweep of the build host's own leftovers (the code tree and build cache).",
  },
  'patch/patch-repo.service.ts#exec': {
    verdict: STAGING,
    why: "The Patch editor's repository on the build host; its safety is the repository-path check's.",
  },
  'patch/patch-repo-clone.ts#removePatchRepoStep': {
    verdict: STAGING,
    why: "Removes the Patch editor's repository from the build host.",
  },
  'project-config/applier/cloud-service-deploys.service.ts#inspectImage': {
    verdict: STAGING,
    why: 'Reads the CPU of the image staged for an AWS or Google deploy.',
  },
  'project-config/applier/cloud-service-deploys.service.ts#push': {
    verdict: STAGING,
    why: "Pushes the staged image to the Service's own store in its cloud.",
  },
  'project-config/applier/google-service-deploys.service.ts#push': {
    verdict: STAGING,
    why: "Pushes the staged image to the Service's own store in Google Cloud.",
  },

  // --- Cloudgate's own records ---------------------------------------------
  'backups/run-recorder.service.ts#start': {
    verdict: RECORDS,
    why: "A run's log file, on the machine its caller names; each caller refuses a cloud Service before it starts a run.",
  },
  'applications/cloud-delete.ts#record': {
    verdict: RECORDS,
    why: "The log of a cloud Service's Delete, kept beside the Cloud runs on the platform host (ADR-0053's consequences).",
  },
  'databases/common/cloud-database-deletes.ts#record': {
    verdict: RECORDS,
    why: "The log of a cloud database's Delete, kept beside its Cloud runs.",
  },
  'compose/stack-vm-deletes.ts#record': {
    verdict: RECORDS,
    why: "The log of a stack on a Stack VM's Delete, kept beside its Cloud runs on the platform host (#1367).",
  },
  'cron-services/cron-runs.service.ts#appendToLog': {
    verdict: RECORDS,
    why: "A line in a Cron service run's own log.",
  },
  'deployment-engine/deployment-engine.service.ts#failureReason': {
    verdict: RECORDS,
    why: "Reads the tail of a Deployment's own log.",
  },
  'deployments/deployments.service.ts#initLogFile': {
    verdict: RECORDS,
    why: "Creates a Deployment's log file on its build host (ADR-0018).",
  },
  'deployments/deployments.service.ts#logLastLine': {
    verdict: RECORDS,
    why: "Appends a Deployment's closing line to its own log.",
  },
  'deployments/deployments.service.ts#readLogs': {
    verdict: RECORDS,
    why: "Reads a Deployment's own log.",
  },
  'deployments/deployments.service.ts#logFileIsAbsent': {
    verdict: RECORDS,
    why: "Asks whether a Deployment's own log is there.",
  },
  'deployments/log-retention.service.ts#sweepOne': {
    verdict: RECORDS,
    why: "Ages out one machine's Deployment logs (ADR-0020).",
  },
  'common/teardown-steps.ts#reclaimDeploymentLogs': {
    verdict: RECORDS,
    why: "A Delete's removal of the owner's log directory, where its runs wrote it.",
  },
  'common/teardown-steps.ts#reclaimFileMounts': {
    verdict: RECORDS,
    why: "A Delete's removal of the file-mount tree Cloudgate wrote under the Service's `appName`; mounts now refuse a cloud Service, so there is none new.",
  },
  'common/teardown-steps.ts#removeImagesOn': {
    verdict: RECORDS,
    why: 'Removes images Cloudgate built, pulled or preserved, by reference.',
  },
  'common/teardown-steps.ts#removeUntaggedImage': {
    verdict: RECORDS,
    why: "`removeImagesOn`'s follow-up (#1415): removes by id the image behind a tag it just removed, once no tag is left on it — the same image, on the same machine.",
  },
  'common/service-cascade.ts#teardownStepsFor': {
    verdict: RECORDS,
    why: "A Project or Environment Delete's teardown of each child by `appName`; one with a cloud Service deletes it in Cloud runs first (ADR-0038).",
  },
  'common/service-cascade.ts#presenceOf': {
    verdict: RECORDS,
    why: "The cascade's read of whether a child's workload is gone.",
  },
  'rollbacks/rollbacks.service.ts#dropPreservedImage': {
    verdict: RECORDS,
    why: "Removes a rollback image Cloudgate preserved, on the machine it was kept on; a cloud `static` site's point is a folder, not an image.",
  },

  // --- A machine's own ------------------------------------------------------
  'backups/backups.service.ts#listBackupFiles': {
    verdict: MACHINE,
    why: "The restore picker's `rclone lsjson`, run from a Server the caller names; refused on the Hosted host.",
  },
  'destinations/destinations.service.ts#probeBucket': {
    verdict: MACHINE,
    why: 'A Destination connection test from a named Server; refused on the Hosted host.',
  },
  'destinations/destinations.service.ts#listObjects': {
    verdict: MACHINE,
    why: "A Destination's listing from a named Server; refused on the Hosted host.",
  },
  'registries/registries.service.ts#probeLogin': {
    verdict: MACHINE,
    why: 'The `docker login` probe from a named Server; refused on the Hosted host.',
  },
  'docker-ops/cluster.service.ts#getLocalServerIp': {
    verdict: MACHINE,
    why: "The host's own address for its swarm.",
  },
  'docker-ops/cluster.service.ts#removeWorker': {
    verdict: MACHINE,
    why: "A swarm worker of the host or a Server: instance authority's or the Server's.",
  },
  'docker-ops/swarm.service.ts#getSwarmNodes': {
    verdict: MACHINE,
    why: "A machine's swarm: instance authority's or the Server's.",
  },
  'docker-ops/swarm.service.ts#getNodeInfo': {
    verdict: MACHINE,
    why: "A machine's swarm node.",
  },
  'docker-ops/swarm.service.ts#getNodeApplications': {
    verdict: MACHINE,
    why: "A machine's swarm services.",
  },
  'docker-ops/swarm.service.ts#getApplicationInfo': {
    verdict: MACHINE,
    why: "A machine's swarm services.",
  },
  'docker-ops/swarm.service.ts#getAllContainerStats': {
    verdict: MACHINE,
    why: "A machine's container stats.",
  },
  'docker-ops/docker-ops.service.ts#exec': {
    verdict: MACHINE,
    why: "A machine's containers; a Service addressed by id that runs in a Cloud account lists none (`inCloud`), and an unmanaged one is instance authority's.",
  },
  'gateway/gateway-route.ts#writeGatewayRoute': {
    verdict: MACHINE,
    why: "The AI Gateway's route on a machine's Traefik: the box's own (ADR-0053's \"only manages\").",
  },
  'gateway/gateway-route.ts#removeGatewayRouteStep': {
    verdict: MACHINE,
    why: "The AI Gateway's route, removed.",
  },
  'monitoring/monitoring.service.ts#exec': {
    verdict: MACHINE,
    why: "Host or Server metrics: the box's own is instance authority's.",
  },
  'service-health/request-metrics-collector.service.ts#read': {
    verdict: MACHINE,
    why: "A machine's Traefik request counters.",
  },
  'preview-deployments/dns-resolver-certificates.ts#dnsResolverCertificatesOn':
    {
      verdict: MACHINE,
      why: "Reads which DNS-01 certificates a machine's Traefik holds.",
    },
  'realtime/container-access.service.ts#resolveTarget': {
    verdict: MACHINE,
    why: 'Inspects a container the socket names by machine and id; its labels, not the caller, say whose it is (ADR-0012).',
  },
  'realtime/gateways/container-logs.gateway.ts#serviceIsListed': {
    verdict: MACHINE,
    why: 'Asks whether the swarm service a log socket follows is still listed on its machine.',
  },
  'realtime/gateways/container-logs.gateway.ts#handleConnection': {
    verdict: MACHINE,
    why: 'Follows the logs of a container the socket names by machine and id, after the container access check.',
  },
  'realtime/gateways/container-terminal.gateway.ts#handleConnection': {
    verdict: MACHINE,
    why: 'Opens a shell in a container the socket names by machine and id, after the container access check.',
  },
  'realtime/gateways/docker-stats.gateway.ts#collectAndSend': {
    verdict: MACHINE,
    why: 'A `docker stats` read on the machine the socket names; runs nothing for the caller.',
  },
  'realtime/host-stats.service.ts#collect': {
    verdict: MACHINE,
    why: "The host's own CPU, memory and disk.",
  },
  'realtime/local-server-setup.service.ts#setupSshKey': {
    verdict: MACHINE,
    why: "The host's own SSH key, for adding it as a Server.",
  },
  'realtime/local-server-setup.service.ts#getDockerHost': {
    verdict: MACHINE,
    why: "The host's own Docker gateway address.",
  },
  'realtime/local-server-setup.service.ts#isWSL': {
    verdict: MACHINE,
    why: "Whether the host's own kernel is WSL.",
  },
  'servers/servers.service.ts#validate': {
    verdict: MACHINE,
    why: "A Server's own reachability check.",
  },
  'servers/servers.service.ts#audit': {
    verdict: MACHINE,
    why: "A Server's own audit.",
  },
  'servers/servers.service.ts#setup': {
    verdict: MACHINE,
    why: "A Server's own setup.",
  },
  'bought-servers/bought-server-change-steps.service.ts#growFilesystem': {
    verdict: MACHINE,
    why: "A Bought Server's own filesystem, grown on it after its extra storage is grown (#1395).",
  },
  'servers/servers.service.ts#recordRequestMetrics': {
    verdict: MACHINE,
    why: "A Server's own Traefik configuration, read.",
  },
  'settings/cleanup.service.ts#run': {
    verdict: MACHINE,
    why: 'Docker cleanup on a machine: host maintenance (instance authority) or a Server.',
  },
  'settings/cleanup.service.ts#cleanupAll': {
    verdict: MACHINE,
    why: 'Docker cleanup on a machine.',
  },
  'settings/cleanup.service.ts#cleanupAllBackground': {
    verdict: MACHINE,
    why: 'Docker cleanup on a machine.',
  },
  'settings/cleanup.service.ts#getDockerDiskUsage': {
    verdict: MACHINE,
    why: "The host's own Docker disk use.",
  },
  'settings/docker-resource.service.ts#getDockerResourceType': {
    verdict: MACHINE,
    why: "A machine's Docker resource, for host maintenance.",
  },
  'settings/docker-resource.service.ts#reloadDockerResource': {
    verdict: MACHINE,
    why: "A machine's Docker resource, for host maintenance.",
  },
  'settings/docker-resource.service.ts#readEnvironmentVariables': {
    verdict: MACHINE,
    why: "A machine's Docker resource, for host maintenance.",
  },
  'settings/docker-resource.service.ts#readPorts': {
    verdict: MACHINE,
    why: "A machine's Docker resource, for host maintenance.",
  },
  'settings/docker-resource.service.ts#checkPortInUse': {
    verdict: MACHINE,
    why: 'Whether a port is taken on a machine.',
  },
  'settings/gpu-counts.ts#readGpuCounts': {
    verdict: MACHINE,
    why: "A machine's GPUs.",
  },
  'settings/gpu-runtime.ts#readRuntimeConfigured': {
    verdict: MACHINE,
    why: "A machine's GPU runtime.",
  },
  'settings/gpu.service.ts#exec': {
    verdict: MACHINE,
    why: "GPU setup on a machine: host maintenance or a Server's.",
  },
  'settings/gpu.service.ts#setupRemoteServer': {
    verdict: MACHINE,
    why: 'GPU setup on a Server.',
  },
  'settings/gpu.service.ts#setupLocalServer': {
    verdict: MACHINE,
    why: 'GPU setup on the host: instance authority.',
  },
  'settings/runtime-info.service.ts#probe': {
    verdict: MACHINE,
    why: "A machine's Docker and kernel versions.",
  },
  'settings/traefik-files.service.ts#readConfigInPath': {
    verdict: MACHINE,
    why: "A machine's Traefik files: instance authority or the Server's.",
  },
  'settings/traefik-files.service.ts#writeTraefikConfigInPath': {
    verdict: MACHINE,
    why: "A machine's Traefik files.",
  },
  'settings/traefik-files.service.ts#readDirectory': {
    verdict: MACHINE,
    why: "A machine's Traefik files.",
  },
  'settings/traefik-files.service.ts#rotateAccessLogOn': {
    verdict: MACHINE,
    why: "A Server's Traefik access log.",
  },
  'settings/traefik-files.service.ts#deleteAgedAccessLogsOn': {
    verdict: MACHINE,
    why: "A Server's older Traefik access-log files, aged out: its id is a `server` row's, from `ServerAccessLogUpkeepService.tick`, and it runs only through `execAsyncRemote`, never on the platform host.",
  },
  'settings/traefik-files.service.ts#reopenLogs': {
    verdict: MACHINE,
    why: "A machine's Traefik, told to reopen its logs.",
  },
  'settings/traefik-setup.service.ts#reconnectServicesToTraefik': {
    verdict: MACHINE,
    why: "A machine's Traefik network.",
  },
  'settings/updates.service.ts#getServiceImageDigest': {
    verdict: MACHINE,
    why: "Cloudgate's own image.",
  },
  'settings/updates.service.ts#updateServer': {
    verdict: MACHINE,
    why: "Cloudgate's own update.",
  },
  'traefik/config-status.service.ts#anchor': {
    verdict: MACHINE,
    why: "A machine's Traefik log, read.",
  },
  'traefik/config-status.service.ts#readErrors': {
    verdict: MACHINE,
    why: "A machine's Traefik log, read.",
  },
  'traefik/config-status.service.ts#findTraefik': {
    verdict: MACHINE,
    why: "A machine's Traefik container, found.",
  },
  'traefik/traefik-writer.service.ts#loadOrCreateConfig': {
    verdict: MACHINE,
    why: "A machine's main Traefik configuration.",
  },
  'traefik/traefik-writer.service.ts#writeCertificate': {
    verdict: MACHINE,
    why: 'A certificate on a machine: a host certificate is instance authority’s.',
  },
  'traefik/traefik-writer.service.ts#removeCertificate': {
    verdict: MACHINE,
    why: 'A certificate on a machine, removed.',
  },
  'traefik/traefik-writer.service.ts#writeConfig': {
    verdict: MACHINE,
    why: "A route file in a machine's Traefik. `TraefikAppConfigService.regenerate` writes nothing for an Application in a Cloud account and `routePreview` refuses one (their Domains are the cloud's load balancer's), the redirect routes refuse one as the basic-auth routes do, and on the Hosted instance a platform-host write the platform does not claim (`PLATFORM_OWNED`) is refused here, whichever caller forgot.",
  },
  'traefik/traefik-writer.service.ts#removeConfig': {
    verdict: MACHINE,
    why: "Removes one route file by name from a machine's Traefik; runs nothing a caller wrote. Every caller of a Service's file forks a cloud Service away first (`regenerate`, the Domain routes, each Delete), a preview of one has no teardown step, and on the Hosted instance a platform-host removal the platform does not claim (`PLATFORM_OWNED`) is refused here, so a customer's name never removes a platform file such as `hosted.yml`.",
  },

  // --- Only a Service on a Server --------------------------------------------
  'applications/application-ops.ts#scaleApplicationService': {
    verdict: SERVER_ONLY,
    why: 'Start, Stop and Restart fork a cloud Service to its cloud first (`cloudTargetOf`).',
  },
  'applications/application-ops.ts#applicationServiceId': {
    verdict: SERVER_ONLY,
    why: "An Application's swarm service; a cloud one has none to find.",
  },
  'applications/application-ops.ts#removeApplicationService': {
    verdict: SERVER_ONLY,
    why: "A Server Application's Delete; a cloud one is deleted in Cloud runs (ADR-0038).",
  },
  'applications/application-ops.ts#removeApplicationDirectory': {
    verdict: SERVER_ONLY,
    why: "A Server Application's Delete.",
  },
  'applications/application-ops.ts#applicationServicePresence': {
    verdict: SERVER_ONLY,
    why: "Whether a Server Application's swarm service is gone.",
  },
  'applications/application-volumes.ts#removeVolumeOn': {
    verdict: SERVER_ONLY,
    why: "A Server Application's or an AI model's volumes, on its Delete.",
  },
  'applications/gpu-wait.ts#readGpuWait': {
    verdict: SERVER_ONLY,
    why: 'GPUs are held on a run Server only.',
  },
  'ai-models/ai-model-facet.ts#joinAiNetworkForFirstAiModel': {
    verdict: SERVER_ONLY,
    why: "An AI model runs on a Server's GPUs, behind the gateway on `cloudgate-ai`.",
  },
  'ai-models/model-readiness.ts#awaitModelReady': {
    verdict: SERVER_ONLY,
    why: "An AI model's runtime, on its Server.",
  },
  'ai-models/weights-volume.ts#pruneWeightsVolume': {
    verdict: SERVER_ONLY,
    why: "An AI model's weights volume, on its Server.",
  },
  'buckets/bucket-key-rotation.service.ts#removeGarageKeys': {
    verdict: SERVER_ONLY,
    why: "Garage keys: a bucket on a Server's own.",
  },
  'buckets/bucket-key-rotation.service.ts#garage': {
    verdict: SERVER_ONLY,
    why: "Garage's key half: a bucket on a Server's own; a cloud bucket's half is `cloudHalves`.",
  },
  'buckets/bucket-ops.ts#removeBucketService': {
    verdict: SERVER_ONLY,
    why: "A Garage bucket's swarm service and secret.",
  },
  'buckets/buckets.service.ts#deploy': {
    verdict: SERVER_ONLY,
    why: 'Deploys a Garage container; a cloud bucket is made in Cloud runs.',
  },
  'buckets/buckets.service.ts#updateOrigins': {
    verdict: SERVER_ONLY,
    why: "A Garage bucket's CORS; a cloud bucket's are its Cloud run's.",
  },
  'buckets/garage-reach.ts#open': {
    verdict: SERVER_ONLY,
    why: "A Garage bucket's admin port.",
  },
  'compose/compose-directory.ts#reclaimComposeDirectory': {
    verdict: SERVER_ONLY,
    why: "A Compose stack in a Cloud account runs on its own Stack VM, which its run target reaches from the row's place through the cloud's tunnel (ADR-0070), never on the platform host.",
  },
  'compose/compose-network.ts#reclaimComposeNetwork': {
    verdict: SERVER_ONLY,
    why: "A Compose stack in a Cloud account runs on its own Stack VM, which its run target (`stackRootId`) reaches from the row's place through the cloud's tunnel (ADR-0070), never on the platform host.",
  },
  'compose/compose.service.ts#runTarget': {
    verdict: SERVER_ONLY,
    why: "A Compose stack in a Cloud account runs on its own Stack VM, which its run target reaches from the row's place through the cloud's tunnel (ADR-0070), never on the platform host.",
  },
  'deployment-engine/deployment-engine.service.ts#deployCompose': {
    verdict: SERVER_ONLY,
    why: "Its compose program goes to the stack's run target: its Server, the platform host, or its own Stack VM through the cloud's tunnel (ADR-0070). A Stack VM's stack keeps its Deployment log on the platform host.",
  },
  'project-config/applier/cloud-stack-vm-runs.service.ts#awaitFirstBoot': {
    verdict: SERVER_ONLY,
    why: "Waits for a new Stack VM's first boot through the stack's run target, which reaches the Stack VM through the cloud's tunnel (ADR-0070), never the platform host.",
  },
  'project-config/applier/cloud-stack-vm-runs.service.ts#growFilesystem': {
    verdict: SERVER_ONLY,
    why: "Grows a Stack VM's data disk's filesystem after a change through the stack's run target, which reaches the Stack VM through the cloud's tunnel (ADR-0070, #1368), never the platform host.",
  },
  'databases/common/database-ops.ts#scaleDatabaseService': {
    verdict: SERVER_ONLY,
    why: 'Start, Stop and Rebuild ask `inCloud` first and go to the cloud.',
  },
  'databases/common/database-ops.ts#removeDatabaseService': {
    verdict: SERVER_ONLY,
    why: "A Server database's Delete; a cloud one is deleted in Cloud runs.",
  },
  'databases/common/database-ops.ts#volumeHolders': {
    verdict: SERVER_ONLY,
    why: "A Server database's volume, on its Delete.",
  },
  'databases/common/database-ops.ts#removeDatabaseVolume': {
    verdict: SERVER_ONLY,
    why: "A Server database's volume, on its Delete.",
  },
  'databases/common/database-ops.ts#databaseServicePresence': {
    verdict: SERVER_ONLY,
    why: "Whether a Server database's swarm service is gone.",
  },
  'databases/common/database-ops.ts#databaseVolumeLeftBehind': {
    verdict: SERVER_ONLY,
    why: "Whether a Server database's volume is left.",
  },
  'databases/common/database-service.ts#convergeSpec': {
    verdict: SERVER_ONLY,
    why: "A Server database's swarm spec; a cloud one is changed by its Cloud run.",
  },

  // --- Open --------------------------------------------------------------------
  'traces/trace-store.ts#runWithConfig': {
    verdict: OPEN,
    finding: TRACES_FINDING,
  },
  'traces/trace-store.ts#isTraceStoreRunning': {
    verdict: OPEN,
    finding: TRACES_FINDING,
  },
  'traces/trace-store.ts#removeTraceStoreSteps': {
    verdict: OPEN,
    finding: TRACES_FINDING,
  },
  'traces/trace-store.ts#reclaimTraceStoreNetwork': {
    verdict: OPEN,
    finding: TRACES_FINDING,
  },
  'traces/trace-store.ts#traceStoreUiAddress': {
    verdict: OPEN,
    finding: TRACES_FINDING,
  },
  'traces/trace-store.ts#traceStoreSizeBytes': {
    verdict: OPEN,
    finding: TRACES_FINDING,
  },
};

/**
 * The dispatchers themselves, which are not sites: each forks on its
 * `serverId` and runs whatever its caller hands it. Held so a rename cannot
 * quietly drop one from the walk.
 */
const DISPATCHERS = new Set([
  'remote/remote-exec.service.ts#execAsync',
  'remote/remote-exec.service.ts#execAsyncRemote',
  'remote/remote-exec.service.ts#execRemote',
  'remote/remote-exec.service.ts#execFileAsync',
  'remote/reachability-memo.ts#execAsync',
  'remote/reachability-memo.ts#execAsyncRemote',
  'remote/reachability-memo.ts#execRemote',
  'remote/reachability-memo.ts#execFileAsync',
  'remote/exec-dispatch.ts#execOnServer',
  'remote/exec-dispatch.ts#execOnServerStdout',
  'remote/run-target.ts#execAt',
  'remote/run-target.ts#execStreamedToLog',
  'docker-ops/server-access.ts#execByServer',
  'destinations/rclone-exec.ts#execRclone',
]);

const FREE_DISPATCHERS = new Set([
  'execOnServer',
  'execOnServerStdout',
  // A run target is a place to exec at, so building one is where a site
  // chooses that place (`remote/run-target.ts`).
  'runTargetOn',
  'execByServer',
  'execRclone',
]);
const METHOD_DISPATCHERS = new Set([
  'execAsync',
  'execAsyncRemote',
  'execRemote',
  'execFileAsync',
]);

const SRC = resolve(__dirname, '../../src');
const GUARD = /\b(?:refuseCloudServiceHostWork|isCloudService)\(/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function isDispatch(node: ts.CallExpression): boolean {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return FREE_DISPATCHERS.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    METHOD_DISPATCHERS.has(callee.name.text)
  );
}

/**
 * A named function, a `const` bound to a function expression, or a class
 * property (whose initializer may be an object of functions, like a
 * `KeyHalf`).
 */
function nameOf(node: ts.Node): string | null {
  if (
    (ts.isMethodDeclaration(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isGetAccessorDeclaration(node)) &&
    node.name &&
    ts.isIdentifier(node.name)
  ) {
    return node.name.text;
  }
  if (ts.isPropertyDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name.text;
  }
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) ||
      ts.isFunctionExpression(node.initializer))
  ) {
    return node.name.text;
  }
  return null;
}

/** The outermost named function `node` is written in. */
function enclosing(node: ts.Node): ts.Node | null {
  let found: ts.Node | null = null;
  for (let at = node.parent; at; at = at.parent) {
    if (nameOf(at)) found = at;
  }
  return found;
}

interface Site {
  readonly key: string;
  readonly body: string;
}

/** Every named function in `src/`, by key, for reading a guard's body. */
const functions = new Map<string, string>();

function sites(): Site[] {
  const found = new Map<string, Site>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
    );
    const prefix = relative(SRC, file);
    const visit = (node: ts.Node): void => {
      const name = nameOf(node);
      if (name && !functions.has(`${prefix}#${name}`)) {
        functions.set(`${prefix}#${name}`, node.getText(source));
      }
      if (ts.isCallExpression(node) && isDispatch(node)) {
        const fn = enclosing(node);
        const key = `${prefix}#${(fn && nameOf(fn)) ?? '(top level)'}`;
        found.set(key, { key, body: fn ? fn.getText(source) : '' });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...found.values()].sort((a, b) => a.key.localeCompare(b.key));
}

describe('isCloudService, as the gate every exec site is classified against', () => {
  const found = sites();
  const classified = found.filter((site) => !DISPATCHERS.has(site.key));

  it('classifies every function that calls an exec dispatcher', () => {
    const unclassified = classified
      .map((site) => site.key)
      .filter((key) => !(key in CENSUS));
    // A failure here is a new exec site: add it to CENSUS with its verdict
    // and why, or refuse a cloud Service in it.
    expect(unclassified).toEqual([]);
  });

  it('lists no site that is gone', () => {
    const keys = new Set(classified.map((site) => site.key));
    expect(Object.keys(CENSUS).filter((key) => !keys.has(key))).toEqual([]);
  });

  it('finds every dispatcher it walks past, so a rename cannot empty it', () => {
    expect([...DISPATCHERS].filter((key) => !functions.has(key))).toEqual([]);
  });

  it('has every refusing site, or the guards it names, ask the cloud seam', () => {
    const unguarded = Object.entries(CENSUS).flatMap(([key, entry]) => {
      if (entry.verdict !== REFUSES) return [];
      return (entry.guards ?? [key]).filter(
        (guard) => !GUARD.test(functions.get(guard) ?? ''),
      );
    });
    expect(unguarded).toEqual([]);
  });

  it('holds the open findings exactly, so the list only shrinks', () => {
    const open = Object.entries(CENSUS)
      .filter(([, entry]) => entry.verdict === OPEN)
      .map(([key]) => key);
    expect(open).toEqual([
      'traces/trace-store.ts#runWithConfig',
      'traces/trace-store.ts#isTraceStoreRunning',
      'traces/trace-store.ts#removeTraceStoreSteps',
      'traces/trace-store.ts#reclaimTraceStoreNetwork',
      'traces/trace-store.ts#traceStoreUiAddress',
      'traces/trace-store.ts#traceStoreSizeBytes',
    ]);
  });
});
