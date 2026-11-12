import type { Provider } from '@nestjs/common';
import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from 'octokit';

/** Injection token for the octokit factory — the GitHub API system boundary. */
export const OCTOKIT_FACTORY = Symbol('OCTOKIT_FACTORY');

export interface GithubAppCredentials {
  appId: number;
  privateKey: string;
  installationId: string;
}

/** Builds an octokit client authenticated as the app installation. */
export type OctokitFactory = (credentials: GithubAppCredentials) => Octokit;

const createOctokit: OctokitFactory = (credentials) =>
  new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: credentials.appId,
      privateKey: credentials.privateKey,
      installationId: credentials.installationId,
    },
  });

export const octokitProvider: Provider = {
  provide: OCTOKIT_FACTORY,
  useValue: createOctokit,
};
