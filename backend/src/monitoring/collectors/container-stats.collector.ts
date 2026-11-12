/**
 * Per-container stats collection: `docker stats` with a JSON format string,
 * run through RemoteExecService (the boundary, phase-40 precedent), with the
 * human units string-parsed. The stored records have quirks of their own:
 * only MiB/GiB are relabeled MB/GB (KiB survives, and its value even parses to
 * 0 through the trim cutset), and net/block units are stored verbatim.
 */

/** One line of {@link DOCKER_STATS_COMMAND}'s output. */
interface DockerStatsLine {
  BlockIO: string;
  CPUPerc: string;
  ID: string;
  MemPerc: string;
  MemUsage: string;
  Name: string;
  NetIO: string;
}

/** The Go database.ContainerMetric JSON shape minus timestamp (caller stamps it). */
export interface ContainerStatsRecord {
  CPU: number;
  Memory: {
    percentage: number;
    used: number;
    total: number;
    usedUnit: string;
    totalUnit: string;
  };
  Network: {
    input: number;
    output: number;
    inputUnit: string;
    outputUnit: string;
  };
  BlockIO: {
    read: number;
    write: number;
    readUnit: string;
    writeUnit: string;
  };
  Container: string;
  ID: string;
  Name: string;
}

export interface MonitoredServices {
  include: string[];
  exclude: string[];
}

// The docker stats format argument, single-quoted for the shell.
export const DOCKER_STATS_COMMAND = `docker stats --no-stream --format '{"BlockIO":"{{.BlockIO}}","CPUPerc":"{{.CPUPerc}}","ID":"{{.ID}}","MemPerc":"{{.MemPerc}}","MemUsage":"{{.MemUsage}}","Name":"{{.Name}}","NetIO":"{{.NetIO}}"}'`;

/** Go strings.TrimRight — strips trailing characters found in the cutset. */
function trimRightCutset(value: string, cutset: string): string {
  let end = value.length;
  while (end > 0 && cutset.includes(value[end - 1])) end -= 1;
  return value.slice(0, end);
}

/** Go strings.TrimLeft(value, "0123456789.") — the unit after the number. */
function unitOf(value: string): string {
  return value.replace(/^[0-9.]+/, '');
}

/** Go strconv.ParseFloat with the error ignored — 0 on anything invalid. */
function num(value: string): number {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Splits "used / total", parsing each side against a trim cutset. */
function parsePair(
  value: string,
  cutset: string,
): [number, string, number, string] {
  const parts = value.split(' / ');
  if (parts.length !== 2) return [0, '', 0, ''];
  const [left] = parts[0].trim().split(/\s+/);
  const [right] = parts[1].trim().split(/\s+/);
  return [
    num(trimRightCutset(left ?? '', cutset)),
    unitOf(left ?? ''),
    num(trimRightCutset(right ?? '', cutset)),
    unitOf(right ?? ''),
  ];
}

/** MiB→MB / GiB→GB, everything else verbatim. */
function relabelMemUnit(unit: string): string {
  if (unit === 'MiB') return 'MB';
  if (unit === 'GiB') return 'GB';
  return unit;
}

/** One docker stats line as the stored container record. */
export function mapContainerStats(
  container: DockerStatsLine,
): ContainerStatsRecord {
  const cpu = num(container.CPUPerc.replace(/%$/, ''));
  const memPerc = num(container.MemPerc.replace(/%$/, ''));

  const [memUsed, memUsedUnit, memTotal, memTotalUnit] = parsePair(
    container.MemUsage,
    'MiBGiB',
  );
  const [netIn, netInUnit, netOut, netOutUnit] = parsePair(
    container.NetIO,
    'kMGTB',
  );
  const [blockRead, blockReadUnit, blockWrite, blockWriteUnit] = parsePair(
    container.BlockIO,
    'kMGTB',
  );

  return {
    CPU: cpu,
    Memory: {
      percentage: memPerc,
      used: memUsed,
      total: memTotal,
      usedUnit: relabelMemUnit(memUsedUnit),
      totalUnit: relabelMemUnit(memTotalUnit),
    },
    Network: {
      input: netIn,
      output: netOut,
      inputUnit: netInUnit,
      outputUnit: netOutUnit,
    },
    BlockIO: {
      read: blockRead,
      write: blockWrite,
      readUnit: blockReadUnit,
      writeUnit: blockWriteUnit,
    },
    Container: container.ID,
    ID: container.ID,
    Name: container.Name,
  };
}

/** Whether a container is monitored: exclude wins, then include. */
export function shouldMonitorContainer(
  containerName: string,
  services: MonitoredServices,
): boolean {
  if (services.exclude.some((excluded) => containerName.includes(excluded))) {
    return false;
  }
  if (services.include.length > 0) {
    return services.include.some((included) =>
      containerName.includes(included),
    );
  }
  return true;
}

/**
 * The same rule asked backwards, for a name nobody is holding a container for:
 * which exclusions suppress **every** container `appName` could name.
 *
 * `shouldMonitorContainer` above is asked at collection time, with a real
 * container's name in hand. `getContainerMetrics` has to answer a related
 * question with no container at all — its `appName` resolves against *stored
 * rows*, so a name the operator excluded and a name nobody has ever heard of
 * are the same "no rows" to it, and it refused both with "nothing running here
 * matches that name, or collection has not stored its first sample yet". For an
 * excluded name both halves of that are false, and the true cause is the one
 * the operator can act on.
 *
 * **What may be claimed is narrower than what may be true**, because both lists
 * match as substrings of the *container's* name:
 *
 * - An entry that is a substring of `appName` catches every container `appName`
 *   can match, whatever is running. That is the reported case — one name typed
 *   into both boxes — and it is certain without a container listing.
 * - An entry the other way round (`app-nk3zbo` excluded while `app` is
 *   included) catches some containers and not others, and which is which is not
 *   in the config. It is deliberately not returned: swapping a vague truth for a
 *   confident falsehood is the defect being fixed, not a new spelling of it.
 *
 * A blank entry is dropped before anything else — `''` is a substring of every
 * string, so one line of whitespace in the textarea would otherwise exclude the
 * world.
 */
export function exclusionsForAppName(
  appName: string,
  exclude: readonly string[] | undefined,
): string[] {
  return (exclude ?? []).filter(
    (entry) => entry.trim() !== '' && appName.includes(entry),
  );
}

/**
 * The other half of the same question: exclusions that suppress **some** of what
 * `appName` could name, without being able to claim all of it.
 *
 * `app-nk3zbo` queried against an exclude entry of `app-nk3zbo.1` is the case
 * this exists for, and it is not a contrived one — **`.1` names are what the
 * console's own picker displays**, so an operator reading a container off that
 * list and pasting it into "Never collect for" produces exactly this. The
 * refusal fell back to "nothing running here matches that name", which is the
 * sentence this rule exists to remove, about a container that was running and
 * had been deliberately switched off.
 *
 * It is a separate function rather than a second direction on
 * {@link exclusionsForAppName} because **the two license different sentences,
 * and merging them would put a false one on the wire.** `app-nk3zbo.1` excludes
 * replica 1 and says nothing about replica 2, so "nothing will ever be sampled
 * under this name" — true of a certain match — is false here. What is true is
 * narrower and still worth saying: the operator typed something that is
 * suppressing part of what they are asking about, and they can see which entry
 * it is. Staying silent instead was considered and rejected: silence puts the
 * ticket's own false sentence in front of the one operator who has the least
 * reason to doubt it, the one who configured the exclusion themselves.
 *
 * **The boundary this cannot cross**, recorded so it is not re-filed as a gap:
 * an entry that neither contains nor is contained by `appName` (`app-nk` asked
 * about, `nk3zbo` excluded) can still catch a container named
 * `app-nk3zbo.1.…`, because both are substrings of it. Deciding that needs the
 * container listing, and this read has none — the whole reason it is refusing is
 * that nothing was stored. Containment is where certainty about the *config*
 * ends, so it is where these two functions stop.
 */
export function partialExclusionsForAppName(
  appName: string,
  exclude: readonly string[] | undefined,
): string[] {
  return (exclude ?? []).filter(
    (entry) =>
      entry.trim() !== '' &&
      // Never both: `a.includes(e) && e.includes(a)` is only true when they are
      // equal, and an equal entry is a certain one.
      !appName.includes(entry) &&
      entry.includes(appName),
  );
}

/**
 * The dedup key a `docker stats` line collapses onto: the **service** the
 * container belongs to, so three replicas of one service are sampled once and
 * two different services are sampled twice.
 *
 * **The key is not the name minus its last `-` segment, and that is the whole
 * fix.** The old rule split on `-` and dropped the last segment, which is a
 * compose name's replica index (`project-service-1`). A Swarm task is named
 * `<service>.<replica>.<taskid>` and Cloudgate deploys every Application as
 * `app-<6 chars>`, so `app-cslg4y.1.t6ga…` reduced to `app` — and so did
 * `app-zk77rz.1.nm80…`. `parseContainerStatsOutput`'s dedup then kept whichever
 * line the daemon printed first: measured on a box, 102 collection ticks stored
 * 102 rows, `app-cslg4y` reached 79 samples and `app-zk77rz` was sampled zero
 * times with both names included and both containers running. The same rule
 * folded `cloudgate-traefik` and `cloudgate-postgres` onto `cloudgate`. The
 * quirks the module header lists are kept; this one was a defect.
 *
 * **Rejected: reading the owning service off the container's labels.**
 * CONTEXT.md's *Managed container* identifies a service by
 * `com.docker.swarm.service.name`, `com.docker.compose.project` or
 * `com.docker.stack.namespace`, and that is the authoritative answer — but
 * `docker stats --format` has no label placeholder, so it would take a second
 * command per tick (`docker ps` or `docker inspect`) over `RemoteExecService`,
 * joined on container id, with the two outputs disagreeing about any container
 * that started or died between them. The name already carries the service in
 * both schemes this product produces, and the stored column is the **full** name
 * (`monitoring.service.ts`), so nothing downstream needs the label.
 *
 * **Deliberately not shared with `serviceNameOf` in `monitoring.service.ts`.**
 * That one is the read path's *queryable* series name and its dotless branch has
 * to return the whole name — `resolveServiceName` matches stored rows on
 * `= name OR LIKE 'name.%'`, so reducing a stored `cloudgate-traefik` there
 * would match nothing. Two rules for two jobs; they agree on every dotted name.
 */
export function getServiceName(containerName: string): string {
  const name = containerName.replace(/^\//, '');
  const dot = name.indexOf('.');
  if (dot !== -1) return name.slice(0, dot);
  const composeReplica = /^(.+)-\d+$/.exec(name);
  return composeReplica ? composeReplica[1] : name;
}

/**
 * One docker stats output, collected: parse each JSON line (broken lines
 * skipped), filter by include/exclude, keep only the first container per
 * service name.
 *
 * "Per service" is the dedup's promise and `getServiceName` is what makes it
 * true; until it was fixed that key was per *host* in practice, so one tick
 * could only ever store one Application. The loop itself is unchanged.
 */
export function parseContainerStatsOutput(
  output: string,
  services: MonitoredServices,
): ContainerStatsRecord[] {
  const records: ContainerStatsRecord[] = [];
  const seenServices = new Set<string>();

  for (const line of output.split('\n')) {
    if (line === '') continue;
    let container: DockerStatsLine;
    try {
      container = JSON.parse(line) as DockerStatsLine;
    } catch {
      continue;
    }
    if (!shouldMonitorContainer(container.Name, services)) continue;

    const serviceName = getServiceName(container.Name);
    if (seenServices.has(serviceName)) continue;
    seenServices.add(serviceName);

    records.push(mapContainerStats(container));
  }
  return records;
}
