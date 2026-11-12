import type { GithubPushEvent } from '../git-providers/strategies/github/github-webhook.util';

/**
 * What a Deployment a push triggered records about that push: a title
 * that tells it apart from a "Manual deployment", and a description naming the
 * branch, the pusher and the commit, so an operator can find the push on the
 * repository without opening the log.
 *
 * **The full commit hash, not a short one.** The description is the only place
 * the commit is written — there is no commit column — and a seven-character
 * prefix is ambiguous in a large enough repository. The subject line alone
 * follows it; a commit body can run to pages and the row renders on one line.
 *
 * A column of its own for the commit was rejected for now: nothing reads one
 * (the engine's `getCommitInfo` has no caller) and the deployments list already
 * renders the description under the title, which is where an operator looks.
 */
export function pushDeployMeta(event: GithubPushEvent): {
  title: string;
  description: string;
} {
  const by = event.pusher ? ` by ${event.pusher}` : '';
  const subject = event.commitMessage.split('\n')[0].trim();
  return {
    title: 'Automatic deployment',
    description: [`Push to ${event.branch}${by}`, event.commitHash, subject]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * A push that names no branch (a tag), deletes one, or carries no head commit
 * has nothing to build, whatever Application it matches.
 */
export function pushHasNothingToBuild(event: GithubPushEvent): boolean {
  return event.deleted || !event.branch || !event.commitHash;
}
