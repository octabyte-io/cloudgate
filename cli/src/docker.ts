import { spawn } from 'node:child_process';

/** What one `docker` command said, and how it exited. */
export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs `docker <args>` and resolves once it has exited; rejects only when
 * `docker` could not be started at all (no Docker: an `ENOENT`). The one
 * way the CLI reaches Docker (`cloudgate template try`), so a test can
 * stand in for it as it does for `fetch`.
 */
export type DockerRun = (
  args: string[],
  options?: { cwd?: string },
) => Promise<DockerResult>;

/** The `docker` on `PATH`, its output collected. */
export const runDocker: DockerRun = (args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: options?.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

/** Whether a {@link DockerRun} rejected because there is no `docker`. */
export function isDockerMissing(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}
