import type { Provider } from '@nestjs/common';

/**
 * Injection token for the HTTP client the OAuth-backed git providers
 * (GitLab, Bitbucket, Gitea) talk to their REST APIs with — the system
 * boundary tests replace. GitHub goes through octokit instead.
 */
export const FETCH_CLIENT = Symbol('FETCH_CLIENT');

export type FetchClient = typeof fetch;

export const fetchClientProvider: Provider = {
  provide: FETCH_CLIENT,
  useValue: fetch,
};
