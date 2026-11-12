import {
  HF_TOKEN_RUNTIMES_PHRASE,
  INFERENCE_RUNTIMES,
  runtimeImage,
} from '../../src/ai-models/inference-runtime';

/**
 * The llama.cpp arm of the runtime descriptor, at its seam: what the
 * platform writes for an AI model on llama.cpp, and the rule that prunes its
 * weights volume after a successful swap. The values are the ticket's
 * decided choices, and the cache layout is llama.cpp's own at the pinned
 * build (`common/hf-cache.cpp`): with `LLAMA_CACHE` set, the cache *is* the
 * hub directory, one `models--<org>--<repo>` per repo.
 */

const llamaCpp = INFERENCE_RUNTIMES['llama.cpp'];
const CACHE = '/root/.cache/llama.cpp';
const MODEL = 'ggml-org/gemma-3-1b-it-GGUF:Q4_K_M';

describe('INFERENCE_RUNTIMES', () => {
  describe('llama.cpp: what the platform writes', () => {
    it('runs the CUDA server build for an AI model that reserves a GPU, and the CPU one otherwise, on the pinned build', () => {
      expect(runtimeImage('llama.cpp', null, 1)).toBe(
        'ghcr.io/ggml-org/llama.cpp:server-cuda-b11434',
      );
      expect(runtimeImage('llama.cpp', null, 0)).toBe(
        'ghcr.io/ggml-org/llama.cpp:server-b11434',
      );
    });

    it('starts llama-server fetching the model itself with -hf, offloading every layer only when a GPU is reserved', () => {
      expect(llamaCpp.command).toBe('/app/llama-server');
      expect(llamaCpp.args(MODEL, 0)).toEqual([
        '-hf',
        MODEL,
        '--host',
        '0.0.0.0',
        '--port',
        '8080',
      ]);
      expect(llamaCpp.args(MODEL, 2)).toEqual([
        '-hf',
        MODEL,
        '--host',
        '0.0.0.0',
        '--port',
        '8080',
        '--n-gpu-layers',
        '999',
      ]);
    });

    it('listens on 8080 and is ready when /health answers, with ten minutes to download and load first', () => {
      expect(llamaCpp.port).toBe(8080);
      expect(llamaCpp.healthCheck.Test).toEqual([
        'CMD',
        'curl',
        '-f',
        'http://localhost:8080/health',
      ]);
      expect(llamaCpp.healthCheck.StartPeriod).toBe(600_000_000_000);
      expect(llamaCpp.readinessCommand(MODEL)).toEqual([
        'curl',
        '-f',
        'http://localhost:8080/health',
      ]);
      expect(llamaCpp.readinessWords).toEqual({
        doing: 'Loading',
        done: 'loaded',
      });
    });

    it('keeps its cache on the weights volume through LLAMA_CACHE, takes a Hugging Face token and no /dev/shm tmpfs', () => {
      expect(llamaCpp.weightsPath).toBe(CACHE);
      expect(llamaCpp.env).toEqual({ LLAMA_CACHE: CACHE });
      expect(llamaCpp.takesHfToken).toBe(true);
      expect(llamaCpp.sharedMemoryTmpfs).toBe(false);
    });
  });

  describe('llama.cpp: prune after a swap', () => {
    /** Runs the descriptor's rule over a listing, as `pruneWeightsVolume` does. */
    const pruned = (listing: string, model: string): string[] =>
      llamaCpp
        .listedModels(listing)
        .filter((listed) => !llamaCpp.isServedModel(listed, model));

    it('lists the cache itself, hidden entries included', () => {
      expect(llamaCpp.listModelsCommand).toEqual(['ls', '-1A', CACHE]);
    });

    it('keeps the served repo, whatever quant it is served at, and names every other entry of the cache', () => {
      const listing = [
        'models--ggml-org--gemma-3-1b-it-GGUF',
        'models--Qwen--Qwen2.5-0.5B-Instruct-GGUF',
        'ggml-org_gemma-3-1b-it-GGUF_gemma-3-1b-it-Q4_K_M.gguf',
        'manifest=ggml-org=gemma-3-1b-it-GGUF=latest.json',
        '.locks',
        '',
      ].join('\n');

      expect(pruned(listing, MODEL)).toEqual([
        'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
        'ggml-org_gemma-3-1b-it-GGUF_gemma-3-1b-it-Q4_K_M.gguf',
        'manifest=ggml-org=gemma-3-1b-it-GGUF=latest.json',
        '.locks',
      ]);
      expect(
        pruned(
          'models--ggml-org--gemma-3-1b-it-GGUF\n',
          'ggml-org/gemma-3-1b-it-GGUF',
        ),
      ).toEqual([]);
    });

    it('removes each one by its own path in the cache, a repo by its cache directory', () => {
      expect(
        llamaCpp.removeModelsCommand([
          'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
          'manifest=ggml-org=gemma-3-1b-it-GGUF=latest.json',
          '.locks',
        ]),
      ).toEqual([
        'rm',
        '-rf',
        '--',
        `${CACHE}/models--Qwen--Qwen2.5-0.5B-Instruct-GGUF`,
        `${CACHE}/manifest=ggml-org=gemma-3-1b-it-GGUF=latest.json`,
        `${CACHE}/.locks`,
      ]);
    });

    it('never names the cache itself or a path outside it', () => {
      expect(pruned('.\n..\n../etc\nmodels--a--b/c\n', MODEL)).toEqual([]);
    });
  });

  describe('what vLLM and llama.cpp share', () => {
    it('both read a hub cache directory back as the repo it holds, and vLLM lists nothing that is not a model', () => {
      const listing =
        'models--Qwen--Qwen2.5-0.5B\ndatasets--a--b\n.locks\nmodels--a--b/c\n';
      expect(INFERENCE_RUNTIMES.vllm.listedModels(listing)).toEqual([
        'Qwen/Qwen2.5-0.5B',
      ]);
      expect(llamaCpp.listedModels('models--Qwen--Qwen2.5-0.5B\n')).toEqual([
        'Qwen/Qwen2.5-0.5B',
      ]);
    });

    it('both give the task ten minutes to download and load its model before a failed probe counts', () => {
      const { vllm } = INFERENCE_RUNTIMES;
      const vllmTiming = { ...vllm.healthCheck, Test: undefined };
      const llamaTiming = { ...llamaCpp.healthCheck, Test: undefined };
      expect(llamaTiming).toEqual(vllmTiming);
      expect(vllmTiming.StartPeriod).toBe(600_000_000_000);
    });

    it('a refusal of a Hugging Face token names every runtime that takes one', () => {
      expect(HF_TOKEN_RUNTIMES_PHRASE).toBe('vLLM or llama.cpp');
    });
  });
});
