import type { GitProviderType } from '../../git-providers/git-provider.schema';
import type { ConfigReader, ConfigReadResult } from './config-reader.port';

/**
 * Where a repository-kept config is read: the connection it is read
 * through — `null` once that connection is deleted — the repository and the
 * path. The one shape every reader of a location uses.
 */
export interface RepositoryPlace {
  readonly gitProviderId: string | null;
  readonly providerType: GitProviderType | null;
  readonly repository: string;
  readonly path: string;
}

/**
 * One copy read through the config reader port at `ref` (`null` is the
 * default branch). A place whose connection was deleted is unreachable
 * without asking the port.
 */
export function readPlace(
  reader: ConfigReader,
  place: RepositoryPlace,
  ref: string | null,
): Promise<ConfigReadResult> {
  if (place.gitProviderId === null || place.providerType === null) {
    return Promise.resolve({
      ok: false,
      reason: 'repository-unreachable',
      branch: ref,
      message: `The git provider connection this config was read through was deleted, so ${place.repository} cannot be reached; move the config to a connection that reaches it`,
    });
  }
  return reader.read({
    connection: {
      gitProviderId: place.gitProviderId,
      providerType: place.providerType,
    },
    repository: place.repository,
    path: place.path,
    ref,
  });
}
