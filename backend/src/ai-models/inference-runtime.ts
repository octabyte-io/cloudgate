import type { HealthCheckSwarm } from '../applications/swarm.types';
import type { InferenceRuntime } from './ai-model.schema';

/**
 * What the platform writes for one inference runtime: the settings an
 * AI model's Application row is created with, the env every deploy injects,
 * and how the deploy knows the model is ready.
 *
 * The row's settings are written once, at create, and are then the deploy's
 * truth like any Application's. The env is injected at every converge
 * (`mechanize.ts`) and wins over the operator's own, so it is the platform's
 * and not a value the operator can edit away.
 */
export interface InferenceRuntimeDescriptor {
  /** The runtime as an operator message names it: "vLLM", "llama.cpp". */
  readonly name: string;
  /**
   * The image an AI model reserving `gpus` per copy runs at `tag`, the
   * facet's or {@link pinnedTag}. The GPU count chooses the build: vLLM ships
   * its CPU one as a repository of its own, and llama.cpp as a tag
   * prefix on the same build, so the tag is a release either way and
   * survives a change of GPUs.
   */
  image(tag: string, gpus: number): string;
  /** The release the platform was tested with: the default, and "on the pin". */
  readonly pinnedTag: string;
  readonly command: string;
  /**
   * The args the runtime starts with, for `gpus` reserved per copy. vLLM and
   * llama.cpp name their model on the command line, and llama.cpp offloads
   * its layers only onto a reserved card, so the args are rewritten
   * when the model or the GPU count is (`admitAiModelEdit`).
   */
  args(model: string, gpus: number): string[];
  /** The port the runtime's API listens on inside the overlay. */
  readonly port: number;
  readonly healthCheck: HealthCheckSwarm;
  /** Platform-owned env, injected at every converge over the operator's. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The command, run in a running task, whose success is the AI model's
   * readiness. For Ollama it is the platform's pull of the model:
   * `ollama pull` is the runtime's own client for `POST /api/pull`, and the
   * image has no HTTP client of its own to call it with. `GET /` answers long
   * before the model is there, so it is not readiness. For vLLM and
   * llama.cpp it is `GET /health`, which answers only once the model is
   * loaded.
   */
  readinessCommand(model: string): string[];
  /** How the deploy log names the readiness step: "Pulling", "pulled". */
  readonly readinessWords: { readonly doing: string; readonly done: string };
  /**
   * Where the runtime keeps its weights inside the task: the target of
   * the AI model's weights volume, and what the runtime's own env names as
   * its weights path, so the two cannot disagree.
   */
  readonly weightsPath: string;
  /**
   * Whether the task gets a `tmpfs` at `/dev/shm`: vLLM's workers
   * share tensors through it, and Swarm has no `--ipc` or `--shm-size`, so
   * Docker's 64 MB default would be all it had.
   */
  readonly sharedMemoryTmpfs: boolean;
  /**
   * Whether the runtime reads a Hugging Face token for gated weights:
   * the facet takes one only then, and the deploy injects it as
   * `HF_TOKEN`.
   */
  readonly takesHfToken: boolean;
  /** The command, run in a running task, that lists the models it holds. */
  readonly listModelsCommand: readonly string[];
  /** The models {@link listModelsCommand}'s output names, as it spells them. */
  listedModels(stdout: string): string[];
  /** Whether a listed model is the facet's `model`, however it was spelled. */
  isServedModel(listed: string, model: string): boolean;
  /** The command, run in a running task, that deletes these models. */
  removeModelsCommand(models: readonly string[]): string[];
}

const SECOND_NS = 1_000_000_000;
const OLLAMA_PORT = 11434;
/** Ollama's own default for root, written out so `OLLAMA_MODELS` and the
 * weights volume's target are one constant. */
const OLLAMA_WEIGHTS_PATH = '/root/.ollama/models';

/**
 * An Ollama model name with its tag made explicit: `ollama pull llama3.2`
 * stores, and `ollama list` names, `llama3.2:latest`. The tag is whatever
 * follows a `:` in the last path segment, so a registry port is not one.
 */
function ollamaCanonicalName(name: string): string {
  const lower = name.trim().toLowerCase();
  const lastSegment = lower.slice(lower.lastIndexOf('/') + 1);
  return lastSegment.includes(':') ? lower : `${lower}:latest`;
}

const ollama: InferenceRuntimeDescriptor = {
  name: 'Ollama',
  image: (tag) => `ollama/ollama:${tag}`,
  pinnedTag: '0.12.6',
  // The image's own entrypoint and command, written out so a later image
  // that changes either does not change what the platform runs. The model is
  // pulled after start, never named here.
  command: '/bin/ollama',
  args: () => ['serve'],
  port: OLLAMA_PORT,
  // `ollama list` asks the server it is beside over `OLLAMA_HOST`; the image
  // carries no curl or wget to probe `/` with.
  healthCheck: {
    Test: ['CMD', '/bin/ollama', 'list'],
    Interval: 10 * SECOND_NS,
    Timeout: 5 * SECOND_NS,
    StartPeriod: 10 * SECOND_NS,
    Retries: 3,
  },
  env: {
    OLLAMA_HOST: `0.0.0.0:${OLLAMA_PORT}`,
    OLLAMA_MODELS: OLLAMA_WEIGHTS_PATH,
  },
  readinessCommand: (model) => ['/bin/ollama', 'pull', model],
  readinessWords: { doing: 'Pulling', done: 'pulled' },
  weightsPath: OLLAMA_WEIGHTS_PATH,
  sharedMemoryTmpfs: false,
  takesHfToken: false,
  // `ollama list` and `ollama rm` are the runtime's own client for `GET
  // /api/tags` and `DELETE /api/delete`, for `readinessCommand`'s reason.
  listModelsCommand: ['/bin/ollama', 'list'],
  // A header row (`NAME ID SIZE MODIFIED`), then one model per line, its
  // name the first column.
  listedModels: (stdout) =>
    stdout
      .split('\n')
      .map((line) => line.trim().split(/\s+/)[0])
      .filter((name) => name && name !== 'NAME'),
  isServedModel: (listed, model) =>
    ollamaCanonicalName(listed) === ollamaCanonicalName(model),
  removeModelsCommand: (models) => ['/bin/ollama', 'rm', ...models],
};

const VLLM_PORT = 8000;
/** The Hugging Face cache vLLM reads and fills: `HF_HOME`, and the weights
 * volume's target. */
const VLLM_WEIGHTS_PATH = '/root/.cache/huggingface';
/** Where in {@link VLLM_WEIGHTS_PATH} the hub keeps one directory per repo. */
const HF_HUB = `${VLLM_WEIGHTS_PATH}/hub`;
const HF_REPO_PREFIX = 'models--';

/**
 * vLLM's own health route, asked with the image's Python: neither vLLM image
 * is promised a curl or wget. vLLM binds its port only once the model is
 * loaded, so a model still downloading and one that cannot load both fail it.
 */
const vllmHealthProbe = [
  'python3',
  '-c',
  `import urllib.request; urllib.request.urlopen('http://127.0.0.1:${VLLM_PORT}/health', timeout=4)`,
];

/**
 * A Hugging Face repo id as the hub cache names its directory:
 * `Qwen/Qwen2.5-0.5B` is `models--Qwen--Qwen2.5-0.5B`. The hub refuses `--`
 * in a repo name, so the mapping runs both ways.
 */
const hfCacheDir = (repo: string) =>
  `${HF_REPO_PREFIX}${repo.split('/').join('--')}`;

/**
 * The repo a hub cache directory holds, {@link hfCacheDir} run backwards:
 * `models--Qwen--Qwen2.5-0.5B` is `Qwen/Qwen2.5-0.5B`. Anything that is not
 * a model's directory (a dataset's, a space's, `.locks`) is `null`.
 */
const repoOfCacheDir = (name: string): string | null =>
  name.startsWith(HF_REPO_PREFIX)
    ? name.slice(HF_REPO_PREFIX.length).split('--').join('/')
    : null;

/**
 * The health check of a runtime that downloads, then loads, its model
 * before `probe` passes: failures in the first ten minutes do
 * not count against the task.
 */
const loadingModelHealthCheck = (
  probe: readonly string[],
): HealthCheckSwarm => ({
  Test: ['CMD', ...probe],
  Interval: 10 * SECOND_NS,
  Timeout: 5 * SECOND_NS,
  StartPeriod: 600 * SECOND_NS,
  Retries: 3,
});

const vllm: InferenceRuntimeDescriptor = {
  name: 'vLLM',
  // The CUDA build on Docker Hub, and vLLM's own CPU build, which it
  // publishes to a repository of its own at the same release tags.
  image: (tag, gpus) =>
    `${gpus >= 1 ? 'vllm/vllm-openai' : 'public.ecr.aws/q9t5s3a7/vllm-cpu-release-repo'}:${tag}`,
  pinnedTag: 'v0.11.0',
  // Both images install the `vllm` CLI; written out over their entrypoints
  // for Ollama's reason.
  command: 'vllm',
  args: (model) => [
    'serve',
    model,
    '--host',
    '0.0.0.0',
    '--port',
    String(VLLM_PORT),
  ],
  port: VLLM_PORT,
  // Readiness is the model loaded, and a large one downloads first.
  healthCheck: loadingModelHealthCheck(vllmHealthProbe),
  env: { HF_HOME: VLLM_WEIGHTS_PATH },
  // The health check again, once the release has converged: a converge
  // whose budget ran out before the load finished is not readiness.
  readinessCommand: () => vllmHealthProbe,
  readinessWords: { doing: 'Loading', done: 'loaded' },
  weightsPath: VLLM_WEIGHTS_PATH,
  sharedMemoryTmpfs: true,
  takesHfToken: true,
  listModelsCommand: ['ls', '-1', HF_HUB],
  // One directory per cached repo; datasets, spaces and `.locks` are not
  // models and are left alone.
  listedModels: (stdout) =>
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => !name.includes('/'))
      .flatMap((name) => repoOfCacheDir(name) ?? []),
  isServedModel: (listed, model) => listed === model,
  // The repo's blobs and its download lock; `rm -rf` over two paths the
  // listing produced, never a glob.
  removeModelsCommand: (models) => [
    'rm',
    '-rf',
    '--',
    ...models.flatMap((repo) => [
      `${HF_HUB}/${hfCacheDir(repo)}`,
      `${HF_HUB}/.locks/${hfCacheDir(repo)}`,
    ]),
  ],
};

const LLAMA_CPP_PORT = 8080;
/**
 * llama.cpp's cache: `LLAMA_CACHE`, and the weights volume's target. With
 * `LLAMA_CACHE` set, the build pinned below keeps `-hf` downloads in it
 * directly, in the Hugging Face hub's layout (`get_cache_directory` in its
 * `common/hf-cache.cpp`): one `models--<org>--<repo>` directory per repo,
 * holding its `blobs`, `refs` and `snapshots`, with no `hub/` between.
 */
const LLAMA_CPP_WEIGHTS_PATH = '/root/.cache/llama.cpp';

/**
 * llama-server's own health route, asked with the curl both server images
 * install for their own `HEALTHCHECK`. It answers 503 while the model loads
 * and 200 once it is loaded, so a model still downloading and one that
 * cannot load both fail it.
 */
const llamaCppHealthProbe = [
  'curl',
  '-f',
  `http://localhost:${LLAMA_CPP_PORT}/health`,
];

/**
 * A llama.cpp model name's repo: `-hf` takes `<org>/<repo>[:<quant>]`, and
 * the cache keeps one directory per repo whatever quants it holds.
 */
const llamaCppRepo = (model: string) => model.split(':', 1)[0];

/**
 * Whether one line of `ls -1A` names something inside the cache: never the
 * cache itself, its parent, or a path through either.
 */
const isCacheEntry = (name: string) =>
  name !== '' && name !== '.' && name !== '..' && !name.includes('/');

const llamaCpp: InferenceRuntimeDescriptor = {
  name: 'llama.cpp',
  // The server build on ghcr, CUDA or CPU at the same build tag: the GPU
  // count chooses the prefix, as it chooses vLLM's repository.
  image: (tag, gpus) =>
    `ghcr.io/ggml-org/llama.cpp:${gpus >= 1 ? 'server-cuda' : 'server'}-${tag}`,
  // A build of 2026-10-06: the newest at least two weeks old on 2026-10-21
  // with both `server-` and `server-cuda-` images published.
  pinnedTag: 'b11434',
  // The image's entrypoint, written out for Ollama's reason. `/app` is the
  // image's WORKDIR, not on its PATH, so it is named whole.
  command: '/app/llama-server',
  args: (model, gpus) => [
    '-hf',
    model,
    '--host',
    '0.0.0.0',
    '--port',
    String(LLAMA_CPP_PORT),
    // Every layer onto the reserved card; llama.cpp clamps to the model's.
    ...(gpus >= 1 ? ['--n-gpu-layers', '999'] : []),
  ],
  port: LLAMA_CPP_PORT,
  // vLLM's reason: the model downloads, then loads, before it is ready.
  healthCheck: loadingModelHealthCheck(llamaCppHealthProbe),
  env: { LLAMA_CACHE: LLAMA_CPP_WEIGHTS_PATH },
  readinessCommand: () => llamaCppHealthProbe,
  readinessWords: { doing: 'Loading', done: 'loaded' },
  weightsPath: LLAMA_CPP_WEIGHTS_PATH,
  sharedMemoryTmpfs: false,
  // llama-server reads `HF_TOKEN` for gated repos.
  takesHfToken: true,
  // Everything in the cache is pruned but the served repo's directory
  // so the listing is the whole cache, hidden entries included: a
  // repo named as `-hf` names it, anything else (a file an older build's
  // flat layout left, say) by its own name.
  listModelsCommand: ['ls', '-1A', LLAMA_CPP_WEIGHTS_PATH],
  listedModels: (stdout) =>
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(isCacheEntry)
      .map((name) => {
        const repo = repoOfCacheDir(name);
        return repo?.split('/').length === 2 ? repo : name;
      }),
  // The repo, not the quant: other quants of the served repo stay, because
  // which of its blobs a quant uses is llama.cpp's own choice.
  isServedModel: (listed, model) => listed === llamaCppRepo(model),
  // One path in the cache per listed name, a repo's by its directory. No
  // name the listing produces holds a `/` but a repo's.
  removeModelsCommand: (models) => [
    'rm',
    '-rf',
    '--',
    ...models.map(
      (name) =>
        `${LLAMA_CPP_WEIGHTS_PATH}/${name.includes('/') ? hfCacheDir(name) : name}`,
    ),
  ],
};

export const INFERENCE_RUNTIMES: Readonly<
  Record<InferenceRuntime, InferenceRuntimeDescriptor>
> = { ollama, vllm, 'llama.cpp': llamaCpp };

/**
 * The runtimes that take a Hugging Face token, as one phrase for an operator
 * message: "vLLM or llama.cpp". Derived, so a runtime joining
 * {@link INFERENCE_RUNTIMES} does not leave a refusal naming too few.
 */
export const HF_TOKEN_RUNTIMES_PHRASE = new Intl.ListFormat('en', {
  type: 'disjunction',
}).format(
  Object.values(INFERENCE_RUNTIMES)
    .filter((runtime) => runtime.takesHfToken)
    .map((runtime) => runtime.name),
);

/**
 * The image an AI model on `runtime` runs, at `imageTag` or the pin, for
 * `gpus` reserved per copy.
 */
export function runtimeImage(
  runtime: InferenceRuntime,
  imageTag: string | null | undefined,
  gpus: number,
): string {
  const descriptor = INFERENCE_RUNTIMES[runtime];
  return descriptor.image(imageTag ?? descriptor.pinnedTag, gpus);
}

/**
 * The `tmpfs` an AI model whose runtime asks for one gets at `/dev/shm`. No
 * size: it is bounded by the task's memory, as `--ipc=host` would be. The
 * Engine refuses a `tmpfs` with a `Source`, so it is the empty string
 * dockerode's typings ask for.
 */
export const SHARED_MEMORY_MOUNT = {
  Type: 'tmpfs' as const,
  Source: '',
  Target: '/dev/shm',
};

/** Whether the AI model runs a tag other than the platform's tested pin. */
export function isOffPin(
  runtime: InferenceRuntime,
  imageTag: string | null | undefined,
): boolean {
  return (
    imageTag !== null &&
    imageTag !== undefined &&
    imageTag !== INFERENCE_RUNTIMES[runtime].pinnedTag
  );
}
