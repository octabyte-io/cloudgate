import fs from 'node:fs';
import { Logger } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import Docker from 'dockerode';

/** Injection token for the dockerode client bound to the local daemon. */
export const DOCKER_CLIENT = Symbol('DOCKER_CLIENT');

interface DockerSocketCandidate {
  label: string;
  path: string;
}

/**
 * Builds a dockerode client for the local daemon, auto-detecting the socket
 * (DOCKER_HOST, Rancher Desktop, standard /var/run/docker.sock — first that
 * exists wins; dockerode's own defaults otherwise).
 */
export const createDockerClient = (): Docker => {
  const logger = new Logger('DockerClient');
  const candidates: DockerSocketCandidate[] = [];

  if (process.env.DOCKER_HOST) {
    candidates.push({
      label: 'DOCKER_HOST environment variable',
      path: process.env.DOCKER_HOST.replace('unix://', ''),
    });
  }

  if (process.env.HOME) {
    candidates.push({
      label: 'Rancher Desktop socket',
      path: `${process.env.HOME}/.rd/docker.sock`,
    });
  }

  candidates.push({
    label: 'Standard Docker socket',
    path: '/var/run/docker.sock',
  });

  for (const candidate of candidates) {
    try {
      if (candidate.path && fs.existsSync(candidate.path)) {
        logger.log(
          `Using Docker socket (${candidate.label}): ${candidate.path}`,
        );
        return new Docker({ socketPath: candidate.path });
      }
    } catch (error) {
      logger.warn(
        `Docker socket check failed for ${candidate.label} (${candidate.path}): ${
          error instanceof Error ? error.message : 'Unknown error'
        }`,
      );
    }
  }

  logger.log(
    'No Docker socket found; falling back to dockerode defaults. Set DOCKER_HOST to specify one.',
  );
  return new Docker();
};

export const dockerClientProvider: Provider = {
  provide: DOCKER_CLIENT,
  useFactory: createDockerClient,
};
