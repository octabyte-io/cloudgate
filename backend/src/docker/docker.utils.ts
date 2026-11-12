import path from 'node:path';
import type Docker from 'dockerode';
import type { ContainerInfo, ResourceRequirements, Resources } from 'dockerode';
import { parse } from 'dotenv';
import { assertShellSafePath } from '../common/shell-safe-path';
import type {
  DockerMountSpec,
  ServiceMount,
  ServiceResources,
} from './docker.types';

/**
 * Turns a dotenv-style env string into the `KEY=VALUE` array dockerode
 * expects for container/service Env. Values may reference project-level
 * (`${{project.X}}`), environment-level (`${{environment.X}}`) or sibling
 * service variables (`${{X}}`); unknown references throw.
 *
 * **This is the fan-out an authorization decision was taken about
 * (ADR-0014).** `projectEnv` and `environmentEnv` are two *parent* rows, written
 * by `PATCH /projects/:id` and `PATCH /environments/:id`, and this function is
 * where one write to either reaches children: every Service in every
 * Environment under a Project for the first, every Service in an Environment
 * for the second, resolved at each Service's next deploy. Every caller passes
 * the same pair — a Service's container env (`mechanize.ts`), a Database's
 * (`BaseDatabaseService`), a Compose stack's `.env` and its `env -i` prefix
 * (`compose.utils.ts`), and a build's `--build-arg` and `--secret` flags
 * (`builders/strategies/*`) — so all of them inherit the same radius.
 *
 * The gates in front of those two writes are `project: ['update']` and
 * `environment: ['update']` plus one entitlement column each, and
 * neither consults `accessedServices`. ADR-0014 decides that this is what the
 * grants mean rather than a hole to close, so **nothing here bounds the reach,
 * on purpose** — adding a filter to this function would be implementing the
 * option that ADR was written to reject, and it is the wrong layer for it
 * besides: this code runs at deploy, long after the write it would be
 * authorizing. Two properties of it are load-bearing for that decision, both
 * already pinned by `test/docker/docker.utils.spec.ts` and worth keeping when
 * this is edited: the output keys are the *service's* keys, so a parent's
 * variable reaches a child only where the child named it — which is why the
 * reach is a substitution rather than an injection; and an unresolvable
 * reference throws rather than resolving empty, so removing a parent key fails
 * the next deploy of every Service that referenced it.
 *
 * That throw's message is the whole of what the deploy log says about the
 * failure, so it names the variable holding the reference, the reference as
 * typed, where it was looked up, and that the key is *not set* — the
 * operator fixes it on the Project, the Environment or the Service's own list,
 * and needs to be told which.
 *
 * `wired` is the Service's **wired variables** (ADR-0031), built at
 * this deploy from their sources' Outputs and never saved on the Service.
 * Each joins the output beside the typed ones and can be named by a
 * `${{KEY}}` reference like a sibling. A typed value of the same name wins:
 * the console refuses typing one for a linked name, so only a Preview
 * deployment's own `previewEnv` ever has one, and there it is the override
 * ADR-0021 allows. Only a container's runtime env takes `wired`; a build's
 * flags never do, so a build never depends on a private database.
 */
export const prepareEnvironmentVariables = (
  serviceEnv: string | null,
  projectEnv?: string | null,
  environmentEnv?: string | null,
  wired: Readonly<Record<string, string>> = {},
): string[] => {
  const projectVars = parse(projectEnv ?? '');
  const environmentVars = parse(environmentEnv ?? '');
  const serviceVars = parse(serviceEnv ?? '');
  const siblings: Record<string, string> = { ...wired, ...serviceVars };
  const wiredOnly = Object.entries(wired)
    .filter(([key]) => !Object.hasOwn(serviceVars, key))
    .map(([key, value]) => `${key}=${value}`);

  const typed = Object.entries(serviceVars).map(([key, value]) => {
    let resolved = value.replace(/\$\{\{project\.(.*?)\}\}/g, (_, ref) => {
      const projectValue = projectVars[ref as string];
      if (projectValue === undefined) {
        throw new Error(
          `${key} refers to \${{project.${ref}}}, but ${ref} is not set on the Project. Set it on the Project, or change the reference.`,
        );
      }
      return projectValue;
    });

    resolved = resolved.replace(/\$\{\{environment\.(.*?)\}\}/g, (_, ref) => {
      const environmentValue = environmentVars[ref as string];
      if (environmentValue === undefined) {
        throw new Error(
          `${key} refers to \${{environment.${ref}}}, but ${ref} is not set on the Environment. Set it on the Environment, or change the reference.`,
        );
      }
      return environmentValue;
    });

    resolved = resolved.replace(/\$\{\{(.*?)\}\}/g, (_, ref) => {
      const serviceValue = Object.hasOwn(siblings, ref as string)
        ? siblings[ref as string]
        : undefined;
      if (serviceValue === undefined) {
        throw new Error(
          `${key} refers to \${{${ref}}}, but ${ref} is not set beside it. Add ${ref} to these variables, or change the reference.`,
        );
      }
      return serviceValue;
    });

    return `${key}=${resolved}`;
  });
  return [...typed, ...wiredOnly];
};

/**
 * Converts stored string limits into dockerode's ResourceRequirements
 * (memory in bytes, CPU in nano-CPUs: 1e9 per core). Unset fields stay
 * undefined so docker applies no constraint.
 *
 * `parseIntOrUndefined` guards the parse (H-59): a non-numeric limit such as
 * `"512mb"` made `Number.parseInt` return `NaN`, and `MemoryBytes: NaN` reached
 * `createService` — which does not reject it at the API but fails the service at
 * converge time, so the operator read the fault out of `docker service ps`
 * rather than out of the call that caused it. An unparseable limit now falls
 * back to "no constraint", the same shape an absent one already takes.
 */
const parseIntOrUndefined = (value: string): number | undefined => {
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
};

/**
 * `gpus` whole GPUs per copy as a Swarm generic resource. Swarm picks
 * the cards from those the node advertises by ID and hands them to the task;
 * no nvidia device is named here. None at all for 0, so a service with no GPU
 * carries no `GenericResources` key.
 *
 * The cast is dockerode's typings, not the shape: they declare a generic
 * resource as a bare `{ Kind, Value }`, while the Engine API wraps it in
 * `DiscreteResourceSpec` (or `NamedResourceSpec`) — the shape `docker node
 * inspect` reads back and the one `gpu-setup-state.ts` parses.
 */
const gpuReservation = (
  gpus: number | undefined,
): Pick<Resources, 'GenericResources'> =>
  gpus && gpus >= 1
    ? {
        GenericResources: [
          { DiscreteResourceSpec: { Kind: 'GPU', Value: gpus } },
        ] as unknown as Resources['GenericResources'],
      }
    : {};

export const calculateResources = ({
  memoryLimit,
  memoryReservation,
  cpuLimit,
  cpuReservation,
  gpus,
}: ServiceResources & { gpus?: number }): ResourceRequirements => ({
  Limits: {
    MemoryBytes: memoryLimit ? parseIntOrUndefined(memoryLimit) : undefined,
    NanoCPUs: cpuLimit ? parseIntOrUndefined(cpuLimit) : undefined,
  },
  Reservations: {
    MemoryBytes: memoryReservation
      ? parseIntOrUndefined(memoryReservation)
      : undefined,
    NanoCPUs: cpuReservation ? parseIntOrUndefined(cpuReservation) : undefined,
    ...gpuReservation(gpus),
  },
});

export const parseEnvironmentKeyValuePair = (
  pair: string,
): [string, string] => {
  const [key, ...valueParts] = pair.split('=');
  if (!key || !valueParts.length) {
    throw new Error(`Invalid environment variable pair: ${pair}`);
  }
  return [key, valueParts.join('=')];
};

/** Resolved env pairs as an object (build secrets need keyed access). */
export const getEnvironmentVariablesObject = (
  serviceEnv: string | null,
  projectEnv?: string | null,
  environmentEnv?: string | null,
): Record<string, string> => {
  const pairs = prepareEnvironmentVariables(
    serviceEnv,
    projectEnv,
    environmentEnv,
  );

  const result: Record<string, string> = {};
  for (const pair of pairs) {
    const [key, value] = parseEnvironmentKeyValuePair(pair);
    result[key] = value;
  }
  return result;
};

/**
 * `<outputPath>/<filePath>` as a path that may be interpolated into a shell
 * command, or `BadRequestException`.
 *
 * What broke first: `getCreateFileCommand` interpolated the joined path into
 * two *unquoted* `mkdir -p` words, and the command goes to `RemoteExecService`
 * — so a file mount whose `filePath` was `a$(id)/` or ``a`whoami`/`` ran on the
 * build server, as the account that drives Docker. (The redirect target on the
 * write branch was already quoted, which is the asymmetry that made it read as
 * an oversight.) The mounts rule closed the *traversal* on the same value and is
 * orthogonal: `files/a$(id)` normalises somewhere perfectly legal.
 *
 * What broke *second*, and is why both `mkdir -p` words are quoted now: the
 * first fix left them unquoted and made the refusal the only defence, but
 * `SHELL_UNSAFE` is the set that escapes a **double-quoted** word. In an
 * unquoted one, `;` `&` `|` `(` `)` `>` `<` and whitespace separate or
 * redirect on their own and none of them are in it — so
 * `x;touch /root/flag #/` ran on the build server as root while `a$(id)/` was
 * refused: the same injection, at the same sink, past its own fix. The
 * rejected alternative was widening `SHELL_UNSAFE` for this caller, which is
 * the shape that had just failed — it buys a second charset to keep correct
 * forever and leaves the sink one careless edit from being the sole defence
 * again. Quoting is the fix; the refusal is belt-and-braces behind it.
 *
 * Refused rather than escaped, and the character set it is refused on are
 * `common/shell-safe-path.ts`'s — one rule shared with
 * `patch-repo.service.ts`, whose precedent it followed and whose docblock
 * carries why refusal beats escaping for both.
 *
 * Checked *here*, and not at `mount.dto.ts` where the traversal answer went, because
 * `POST /ai/deploy` and a Template's Apply reach `MountsService` with an
 * object they built, so the global pipe never sees their `filePath` —
 * and the builder strategies never had a DTO at all. This is the one place
 * every path goes through. The whole joined path is checked rather than
 * `filePath` alone, because `outputPath` lands in the same shell word.
 *
 * It throws `BadRequestException` from a `docker/` util rather than returning a
 * discriminated result for the callers to convert, which is the one judgement
 * call here: §2.5 says throw Nest built-ins and forbids a custom class, and
 * `patch-repo.service.ts` — also a path util — already answers a bad path this
 * way. A result type would have to be unwrapped identically at all four call
 * sites (`MountsService`, the static strategy's three, the dockerfile
 * strategy's one) to produce the same 400, so it would buy nothing but
 * boilerplate.
 */
export const resolveShellSafePath = (
  outputPath: string,
  filePath: string,
): string => {
  const fullPath = path.join(outputPath, filePath);
  // Every word this lands in is quoted by its builder — the two `mkdir -p`
  // words and the redirect below in double quotes, `MountsService.remove`'s
  // `rm -rf` target as argv — so `common/shell-safe-path.ts`'s set is exactly
  // the one that still escapes, and this is the second line of defence rather
  // than the first.
  assertShellSafePath(fullPath);
  return fullPath;
};

/**
 * Shell command that writes `content` to `<outputPath>/<filePath>`,
 * base64-encoded in transit so arbitrary content survives the shell. A
 * trailing `/` creates a directory.
 *
 * `content` needs no check — base64 in transit is what that encoding is for.
 * The path does: see `resolveShellSafePath`.
 *
 * **Both `mkdir -p` words are double-quoted**, like the redirect target that
 * always was. They were bare until the quoting fix was reopened, and a bare word is not a
 * lesser version of a quoted one — it is a different grammar, in which `;`
 * ends the command and everything after it is a new one the build server runs
 * as itself. Nothing legitimate here needs the quotes (every real path is
 * plain), so they cost nothing and are the only reason a caller-supplied
 * segment stays a segment.
 */
export const getCreateFileCommand = (
  outputPath: string,
  filePath: string,
  content: string,
): string => {
  const fullPath = resolveShellSafePath(outputPath, filePath);
  if (filePath.endsWith('/')) {
    return `mkdir -p "${fullPath}";\n`;
  }

  const directory = path.dirname(fullPath);
  return `mkdir -p "${directory}";\necho "${encodeBase64(content)}" | base64 -d > "${fullPath}";\n`;
};

export const encodeBase64 = (content: string): string =>
  Buffer.from(content, 'utf-8').toString('base64');

/** True when a container with that name/id exists on the daemon. */
export const containerExists = async (
  docker: Docker,
  containerName: string,
): Promise<boolean> => {
  try {
    await docker.getContainer(containerName).inspect();
    return true;
  } catch {
    return false;
  }
};

/** First container whose name matches; throws when none does. */
export const getContainerByName = async (
  docker: Docker,
  name: string,
): Promise<ContainerInfo> => {
  const containers = await docker.listContainers({
    limit: 1,
    filters: { name: [name] },
  });

  const container = containers[0];
  if (!container) {
    throw new Error(`No container found with name: ${name}`);
  }
  return container;
};

/** Maps bind-type mounts to dockerode bind mount specs. */
export const generateBindMounts = (mounts: ServiceMount[]): DockerMountSpec[] =>
  mounts
    .filter((mount) => mount.type === 'bind')
    .map((mount) => ({
      Type: 'bind' as const,
      Source: mount.hostPath ?? '',
      Target: mount.mountPath,
    }));

/**
 * Maps file-type mounts to bind specs sourced from the service's file-mounts
 * directory.
 *
 * **It takes that directory rather than an `applicationsPath` and an
 * `appName`**. It used to join `<applicationsPath>/<appName>/files/`
 * itself, which made this the *second* expression of a path
 * `MountsService.baseFilesPath` also spells — and the source of that bind is
 * the file that writer created, on the machine that writer wrote it to, so the
 * two cannot be allowed to differ by an edit to one of them.
 * `fileMountsDirectoryOnRunServer` is now the one expression, and it is the
 * caller's job because resolving it needs the machine the workload runs on,
 * which this layer does not know.
 *
 * **`Target` is `mountPath` verbatim: the file is bound onto it, not written
 * under it**. `mountPath` is the file's own full path in the container
 * and `filePath` only names the host copy. The console's form says so; joining
 * the two instead would move the file of every stored mount — application and
 * database alike — on its next deploy.
 */
export const generateFileMounts = (
  mounts: ServiceMount[],
  fileMountsDirectory: string,
): DockerMountSpec[] =>
  mounts
    .filter((mount) => mount.type === 'file')
    .map((mount) => ({
      Type: 'bind' as const,
      Source: path.join(
        path.resolve(fileMountsDirectory),
        mount.filePath ?? '',
      ),
      Target: mount.mountPath,
    }));

/** Maps volume-type mounts to dockerode volume mount specs. */
export const generateVolumeMounts = (
  mounts: ServiceMount[],
): DockerMountSpec[] =>
  mounts
    .filter((mount) => mount.type === 'volume')
    .map((mount) => ({
      Type: 'volume' as const,
      Source: mount.volumeName ?? '',
      Target: mount.mountPath,
    }));
