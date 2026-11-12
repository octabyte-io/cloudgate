import { Injectable } from '@nestjs/common';
import type { Provider } from '@nestjs/common';

import type { GitProviderType } from '../../git-providers/git-provider.schema';
import { CONFIG_READER } from './config-reader.port';
import type {
  ConfigReader,
  ConfigReadRequest,
  ConfigReadResult,
} from './config-reader.port';
import { BitbucketConfigReader } from './bitbucket-config-reader';
import { GiteaConfigReader } from './gitea-config-reader';
import { GithubConfigReader } from './github-config-reader';
import { GitlabConfigReader } from './gitlab-config-reader';

/**
 * The config reader behind {@link CONFIG_READER}: picks the implementation
 * by the connection's provider type: one per hosted provider.
 * A custom git URL has no connection, so it is never a config location.
 *
 * **Adding a provider** is one implementation of {@link ConfigReader} beside
 * the others (a REST one through `readOverRest`), one constructor parameter
 * and one entry in `readers` below, and its class in
 * `CONFIG_READER_PROVIDERS`. Nothing else changes: the service, the move and
 * the plans all go through this.
 */
@Injectable()
export class ConfigReaders implements ConfigReader {
  private readonly readers: Record<GitProviderType, ConfigReader>;

  constructor(
    github: GithubConfigReader,
    gitlab: GitlabConfigReader,
    gitea: GiteaConfigReader,
    bitbucket: BitbucketConfigReader,
  ) {
    this.readers = { github, gitlab, gitea, bitbucket };
  }

  read(request: ConfigReadRequest): Promise<ConfigReadResult> {
    return this.readers[request.connection.providerType].read(request);
  }
}

/** The module's providers for the port: each implementation and the token. */
export const CONFIG_READER_PROVIDERS: Provider[] = [
  GithubConfigReader,
  GitlabConfigReader,
  GiteaConfigReader,
  BitbucketConfigReader,
  ConfigReaders,
  { provide: CONFIG_READER, useExisting: ConfigReaders },
];
