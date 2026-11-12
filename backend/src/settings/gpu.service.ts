import { Inject, Injectable } from '@nestjs/common';
import { quote } from 'shell-quote';
import { execByServer } from '../docker-ops/server-access';
import { RemoteExecService } from '../remote/remote-exec.service';
import { NODE_GPU_RESOURCES_COMMAND, readGpuCounts } from './gpu-counts';
import type { GpuCounts } from './gpu-counts';
import {
  GPU_CONFIG_FILES,
  asRootProgram,
  mergeDaemonConfig,
  writeGpuConfigScript,
} from './gpu-setup-script';
import { readRuntimeConfigured } from './gpu-runtime';
import {
  cardIdsFromNvidiaSmi,
  gpuSetupOf,
  qualifiesAsGpuServer,
} from './gpu-setup-state';
import type { GpuSetupState } from './gpu-setup-state';

export interface GpuInfo {
  driverInstalled: boolean;
  driverVersion?: string;
  gpuModel?: string;
  runtimeInstalled: boolean;
  runtimeConfigured: boolean;
  cudaSupport: boolean;
  cudaVersion?: string;
  memoryInfo?: string;
  availableGPUs: number;
  /**
   * **Whether a GPU is advertised to Swarm as a generic resource — not whether
   * this host is in a Swarm**.
   *
   * The name is the wire contract and is kept; what it measures is stated here
   * because deriving the other reading from it produced a screen that
   * contradicted itself. {@link checkSwarmResources} sets it only when
   * `docker node inspect self` lists a `GenericResources` entry of Kind
   * `GPU`/`gpu`, so on a Swarm manager with no GPU the command succeeds,
   * answers `null`, and this stays `false` — which the console rendered as
   * "this host is not in a Swarm" two cards below a This machine card reading
   * `Swarm active`. Swarm membership is `docker info`'s
   * `Swarm.LocalNodeState`, which no probe here reads.
   *
   * It is true in both the old `GPU=<n>` form and the by-card-ID form; which
   * one is {@link gpuSetup}, and only `card-id` qualifies a GPU Server.
   */
  swarmEnabled: boolean;
  /** How many GPUs that generic resource advertises. */
  gpuResources: number;
  /**
   * Not set up, set up the old way (`GPU=<n>`: run setup again), or set up by
   * card ID (`GPU=<uuid>` per card) — see `gpu-setup-state.ts`.
   */
  gpuSetup: GpuSetupState;
  /** The card IDs advertised, when set up by card ID. */
  gpuCardIds: string[];
}

/**
 * How setup waits for Docker to come back after its restart. A token so the
 * e2e suite, whose daemon is a double, does not wait 15 s for nothing.
 */
export const GPU_SETUP_PAUSE = Symbol('GPU_SETUP_PAUSE');
export type GpuSetupPause = (ms: number) => Promise<void>;
export const sleep: GpuSetupPause = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** NVIDIA status probes and swarm GPU setup, on the host or a Server. */
@Injectable()
export class GpuService {
  constructor(
    private readonly remoteExec: RemoteExecService,
    @Inject(GPU_SETUP_PAUSE) private readonly pause: GpuSetupPause,
  ) {}

  // `string | null`, not `string | undefined`: the DTO hands the platform host
  // through as an explicit `null` now rather than 400ing on it, and every
  // dispatch below is `execByServer`'s truthiness test, which already read the
  // two the same way.
  private exec(
    serverId: string | null | undefined,
    command: string | string[],
  ) {
    return execByServer(this.remoteExec, serverId, command);
  }

  /** Driver, runtime, swarm, GPU and CUDA probes, run together and merged. */
  async checkGpuStatus(serverId?: string | null): Promise<GpuInfo> {
    try {
      const [driverInfo, runtimeInfo, swarmInfo, gpuInfo, cudaInfo] =
        await Promise.all([
          this.checkGpuDriver(serverId),
          this.checkRuntime(serverId),
          this.checkSwarmResources(serverId),
          this.checkGpuInfo(serverId),
          this.checkCudaSupport(serverId),
        ]);

      return {
        ...driverInfo,
        ...runtimeInfo,
        ...swarmInfo,
        ...gpuInfo,
        ...cudaInfo,
      };
    } catch {
      return {
        driverInstalled: false,
        driverVersion: undefined,
        runtimeInstalled: false,
        runtimeConfigured: false,
        cudaSupport: false,
        cudaVersion: undefined,
        gpuModel: undefined,
        memoryInfo: undefined,
        availableGPUs: 0,
        swarmEnabled: false,
        gpuResources: 0,
        gpuSetup: 'none',
        gpuCardIds: [],
      };
    }
  }

  /** The counts-only read (`gpu-counts.ts`), live on every call. */
  async counts(serverId?: string | null): Promise<GpuCounts> {
    return (await readGpuCounts(this.remoteExec, serverId)).counts;
  }

  private async checkGpuDriver(serverId?: string | null) {
    let driverVersion: string | undefined;
    let driverInstalled = false;
    let availableGPUs = 0;

    try {
      const driverCommand =
        'nvidia-smi --query-gpu=driver_version --format=csv,noheader';
      const { stdout: nvidiaSmi } = await this.exec(serverId, driverCommand);

      driverVersion = nvidiaSmi.trim();
      if (driverVersion) {
        driverInstalled = true;
        const countCommand =
          'nvidia-smi --query-gpu=gpu_name --format=csv,noheader | wc -l';
        const { stdout: gpuCount } = await this.exec(serverId, countCommand);
        availableGPUs = Number.parseInt(gpuCount.trim(), 10);
      }
    } catch (error) {
      console.debug('GPU driver check:', error);
    }

    return { driverVersion, driverInstalled, availableGPUs };
  }

  private async checkRuntime(serverId?: string | null) {
    let runtimeInstalled = false;
    try {
      const { stdout } = await this.exec(
        serverId,
        'command -v nvidia-container-runtime',
      );
      runtimeInstalled = !!stdout.trim();
    } catch (error) {
      console.debug('Runtime binary check:', error);
    }

    // Docker using the runtime is not enough: without a top-level
    // `swarm-resource` the card Swarm assigns never reaches the container, so
    // a Server set up by an older version is set up again. The same read the
    // GPU reservation refusal makes.
    const runtimeConfigured = await readRuntimeConfigured(
      this.remoteExec,
      serverId,
    );

    return { runtimeInstalled, runtimeConfigured };
  }

  private async checkSwarmResources(serverId?: string | null) {
    let advertised = gpuSetupOf('null');

    try {
      const { stdout: resources } = await this.exec(
        serverId,
        NODE_GPU_RESOURCES_COMMAND,
      );
      advertised = gpuSetupOf(resources);
    } catch (error) {
      console.debug('Swarm resource check:', error);
    }

    return {
      swarmEnabled: advertised.gpuSetup !== 'none',
      ...advertised,
    };
  }

  private async checkGpuInfo(serverId?: string | null) {
    let gpuModel: string | undefined;
    let memoryInfo: string | undefined;

    try {
      const gpuInfoCommand =
        'nvidia-smi --query-gpu=gpu_name,memory.total --format=csv,noheader';
      const { stdout: gpuInfo } = await this.exec(serverId, gpuInfoCommand);
      [gpuModel, memoryInfo] = gpuInfo.split(',').map((s) => s.trim());
    } catch (error) {
      console.debug('GPU info check:', error);
    }

    return { gpuModel, memoryInfo };
  }

  private async checkCudaSupport(serverId?: string | null) {
    let cudaVersion: string | undefined;
    let cudaSupport = false;

    try {
      const cudaCommand = 'nvidia-smi -q | grep "CUDA Version"';
      const { stdout: cudaInfo } = await this.exec(serverId, cudaCommand);

      const cudaMatch = cudaInfo.match(/CUDA Version\s*:\s*([\d.]+)/);
      cudaVersion = cudaMatch ? cudaMatch[1] : undefined;
      cudaSupport = !!cudaVersion;
    } catch (error) {
      console.debug('CUDA support check:', error);
    }

    return { cudaVersion, cudaSupport };
  }

  /**
   * Write the NVIDIA daemon config advertising each card by its ID, restart
   * Docker and label the swarm node; nothing to do once the cards are
   * advertised by ID and the runtime is configured. A machine set up the old
   * way (`GPU=<n>`) is set up again.
   *
   * Only ever run because an operator asked, from the GPU support card after
   * confirming the Docker restart — never by upgrade or deploy
   * (`test/coding-standards/gpu-setup-callers.spec.ts`).
   */
  async setupGpuSupport(serverId?: string | null): Promise<void> {
    try {
      const initialStatus = await this.checkGpuStatus(serverId);
      const shouldContinue = this.validatePrerequisites(initialStatus);
      if (!shouldContinue) return;

      const nodeId = await this.getNodeId(serverId);
      const cardIds = await this.readCardIds(serverId);
      const daemonConfig = mergeDaemonConfig(
        await this.readDaemonJson(serverId),
        cardIds,
      );
      const script = [
        writeGpuConfigScript(daemonConfig),
        'systemctl daemon-reload',
        'systemctl restart docker',
      ].join('\n');

      if (serverId) {
        await this.setupRemoteServer(serverId, script);
      } else {
        await this.setupLocalServer(script);
      }

      // Wait for Docker to come back after the restart.
      await this.pause(10000);
      await this.addGpuLabel(nodeId, serverId);

      await this.pause(5000);
      await this.verifySetup(nodeId, serverId);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes('password is required')
      ) {
        throw new Error(
          'Sudo access required. Please run with appropriate permissions.',
        );
      }
      throw error;
    }
  }

  private validatePrerequisites(initialStatus: GpuInfo): boolean {
    if (!initialStatus.driverInstalled) {
      throw new Error(
        'NVIDIA drivers not installed. Please install appropriate NVIDIA drivers first.',
      );
    }
    if (!initialStatus.runtimeInstalled) {
      throw new Error(
        'NVIDIA Container Runtime not installed. Please install nvidia-container-runtime first.',
      );
    }
    if (
      qualifiesAsGpuServer(initialStatus.gpuSetup) &&
      initialStatus.runtimeConfigured
    ) {
      return false;
    }
    return true;
  }

  private async getNodeId(serverId?: string | null): Promise<string> {
    const nodeIdCommand = 'docker info --format "{{.Swarm.NodeID}}"';
    const { stdout: nodeId } = await this.exec(serverId, nodeIdCommand);

    const trimmedNodeId = nodeId.trim();
    if (!trimmedNodeId) {
      throw new Error('Setup Server before enabling GPU support');
    }
    return trimmedNodeId;
  }

  private async readCardIds(serverId?: string | null): Promise<string[]> {
    const { stdout } = await this.exec(
      serverId,
      'nvidia-smi --query-gpu=uuid --format=csv,noheader',
    );
    return cardIdsFromNvidiaSmi(stdout);
  }

  /** `daemon.json` as it is, `''` when there is none, so setup merges into it. */
  private async readDaemonJson(serverId?: string | null): Promise<string> {
    const file = quote([GPU_CONFIG_FILES.daemonJson]);
    const { stdout } = await this.exec(
      serverId,
      `[ ! -e ${file} ] || sudo -n cat ${file}`,
    );
    return stdout;
  }

  private async setupRemoteServer(
    serverId: string,
    script: string,
  ): Promise<void> {
    await this.remoteExec.execAsyncRemote(
      serverId,
      `sudo -n true && ${asRootProgram(script)}`,
    );
  }

  private async setupLocalServer(script: string): Promise<void> {
    try {
      await this.remoteExec.execAsync(asRootProgram(script));
    } catch {
      throw new Error(
        'Failed to configure GPU support. Please ensure you have sudo privileges and try again.',
      );
    }
  }

  private async addGpuLabel(
    nodeId: string,
    serverId?: string | null,
  ): Promise<void> {
    const labelCommand = `docker node update --label-add gpu=true ${nodeId}`;
    await this.exec(serverId, labelCommand);
  }

  private async verifySetup(
    nodeId: string,
    serverId?: string | null,
  ): Promise<GpuInfo> {
    const finalStatus = await this.checkGpuStatus(serverId);

    // Both halves: the cards advertised by ID, and the runtime set up to hand
    // a task the card Swarm assigned — a top-level `swarm-resource` included,
    // so an `awk` rewrite that left the key inside a table is a failed setup.
    if (
      !qualifiesAsGpuServer(finalStatus.gpuSetup) ||
      !finalStatus.runtimeConfigured
    ) {
      const diagnosticCommands = [
        `docker node inspect ${nodeId}`,
        'nvidia-smi -a | grep "GPU UUID"',
        'cat /etc/docker/daemon.json',
        'cat /etc/nvidia-container-runtime/config.toml',
      ].join(' && ');

      await this.exec(serverId, diagnosticCommands);
      throw new Error(
        qualifiesAsGpuServer(finalStatus.gpuSetup)
          ? 'GPU setup did not leave the NVIDIA runtime configured: Docker must use it by default and its config.toml must set swarm-resource before any table'
          : 'GPU support not detected in swarm after setup',
      );
    }

    return finalStatus;
  }
}
