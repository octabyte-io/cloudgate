import { Module } from '@nestjs/common';
import { DeploymentsModule } from '../deployments/deployments.module';
import { fetchClientProvider } from './fetch.provider';
import { GitProviderOauthController } from './git-provider-oauth.controller';
import { GitProviderOauthService } from './git-provider-oauth.service';
import { GitProvidersController } from './git-providers.controller';
import { GitProvidersService } from './git-providers.service';
import { GitProviderOauthStateService } from './oauth-state.service';
import { BitbucketController } from './strategies/bitbucket/bitbucket.controller';
import { BitbucketService } from './strategies/bitbucket/bitbucket.service';
import { GiteaController } from './strategies/gitea/gitea.controller';
import { GiteaService } from './strategies/gitea/gitea.service';
import { GithubController } from './strategies/github/github.controller';
import { GithubPushService } from './strategies/github/github-push.service';
import { GithubService } from './strategies/github/github.service';
import { octokitProvider } from './strategies/github/octokit.provider';
import { GitlabController } from './strategies/gitlab/gitlab.controller';
import { GitlabService } from './strategies/gitlab/gitlab.service';
import { SourceCloneService } from './source-clone.service';

@Module({
  // For the GitHub webhook's push arm, which deploys.
  imports: [DeploymentsModule],
  controllers: [
    GitProvidersController,
    // Declared before the strategy controllers so the three-segment OAuth
    // routes are matched ahead of anything ending in `:id`.
    GitProviderOauthController,
    GithubController,
    GitlabController,
    BitbucketController,
    GiteaController,
  ],
  providers: [
    GitProvidersService,
    GitProviderOauthService,
    GitProviderOauthStateService,
    GithubService,
    GithubPushService,
    octokitProvider,
    GitlabService,
    BitbucketService,
    GiteaService,
    SourceCloneService,
    fetchClientProvider,
  ],
  exports: [
    GitProvidersService,
    GithubService,
    GitlabService,
    BitbucketService,
    GiteaService,
    SourceCloneService,
  ],
})
export class GitProvidersModule {}
