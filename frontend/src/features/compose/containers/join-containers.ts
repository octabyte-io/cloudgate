import type {
  ContainerListItem,
  ContainerMatch,
  SwarmTask,
} from "@/lib/api/endpoints/docker";

/**
 * One row of the Containers table: a service, and whatever is running for it.
 *
 * The **pure** half of that tab, split from the hooks that feed it because it is
 * the half worth reading twice — every field here comes from a different route and
 * the matching rule is the one thing that could quietly attribute a container to
 * the wrong service.
 */
export type StackContainer = {
  /** The compose service, when the name gives it away. See `serviceOf`. */
  service: string | null;
  /** `null` for a service the file declares and nothing is running for. */
  containerId: string | null;
  name: string;
  /** `docker ps {{.State}}` — **Docker's word**, and `""` for a declared-only row. */
  state: string;
  status: string | null;
  image: string | null;
  ports: string | null;
  /** Swarm only. */
  node: string | null;
  /** Swarm only — why the task is not running. */
  taskError: string | null;
};

/**
 * Match containers to declared services by name.
 *
 * Docker's naming is what makes this possible and it is pinned rather than
 * guessed: the deploy writes `COMPOSE_PROJECT_NAME=<appName>` into the `.env`
 * beside the file (`getCreateComposeEnvFileCommand`) and passes `-p <appName>`, so
 * a compose container is `<appName>-<service>-<n>`; `docker stack deploy <appName>`
 * names each service `<appName>_<service>`, and its containers
 * `<appName>_<service>.<slot>.<taskId>`.
 *
 * Matching on the **declared name** rather than parsing a position out of the
 * string is deliberate: a service called `web-api` and a container called
 * `stack-web-api-1` cannot be split correctly by counting hyphens, and getting it
 * wrong would attribute a container to the wrong service.
 */
export function joinContainers(input: {
  appName: string;
  swarm: boolean;
  declared: string[] | undefined;
  members: ContainerMatch[] | undefined;
  listing: ContainerListItem[] | undefined;
  tasks: SwarmTask[] | undefined;
}): StackContainer[] {
  const { appName, swarm, declared, members, listing, tasks } = input;
  const byId = new Map((listing ?? []).map((row) => [row.containerId, row]));
  const rows: StackContainer[] = [];
  const claimed = new Set<string>();

  for (const container of members ?? []) {
    const service = serviceOf(container.name, appName, declared);
    if (service) claimed.add(service);
    const full = byId.get(container.containerId);
    const task = matchTask(container.name, tasks);
    rows.push({
      service,
      containerId: container.containerId,
      name: container.name,
      state: container.state,
      status: container.status || null,
      image: full?.image ?? null,
      ports: full?.ports && full.ports !== "No ports" ? full.ports : null,
      node: swarm ? (task?.node ?? null) : null,
      taskError: task?.error ? task.error : null,
    });
  }

  // The services the file declares and nothing is running for. Only when the file
  // could be read at all — an unreadable file must not produce a table of ghosts.
  for (const service of declared ?? []) {
    if (claimed.has(service)) continue;
    const task = tasks?.find((row) => row.name.startsWith(`${appName}_${service}.`));
    rows.push({
      service,
      containerId: null,
      name: swarm ? `${appName}_${service}` : `${appName}-${service}`,
      // Deliberately empty rather than a word of our own: `state` is Docker's
      // vocabulary, and `containerMark` labels an unknown value with whatever
      // string it was given — so inventing "missing" here would put our word
      // inside Docker's map. The columns file says what a null container means.
      state: "",
      status: null,
      image: null,
      ports: null,
      node: task?.node ?? null,
      taskError: task?.error ? task.error : null,
    });
  }

  return rows;
}

/** Which declared service this container belongs to, or `null` if unclear. */
function serviceOf(
  containerName: string,
  appName: string,
  declared: string[] | undefined,
): string | null {
  for (const service of declared ?? []) {
    if (
      containerName.startsWith(`${appName}-${service}-`) ||
      containerName.startsWith(`${appName}_${service}.`) ||
      containerName === `${appName}-${service}` ||
      containerName === `${appName}_${service}`
    ) {
      return service;
    }
  }
  return null;
}

/** The Swarm task whose name matches this container's, when there is one. */
function matchTask(
  containerName: string,
  tasks: SwarmTask[] | undefined,
): SwarmTask | undefined {
  // A task is `<stack>_<service>.<slot>` and its container is that plus
  // `.<taskId>`, so the task's name is a prefix of the container's.
  return (tasks ?? []).find((task) => containerName.startsWith(task.name));
}
