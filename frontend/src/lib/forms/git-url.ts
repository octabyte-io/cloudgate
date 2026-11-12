/**
 * The clone URL rule of the `git` source, a copy of the backend's
 * `GIT_CLONE_URL` in `backend/src/git-providers/git-clone-url.ts`, with its
 * sentence: an `http(s)://`, `ssh://` or `git://` URL with a host and a path,
 * or the scp form `user@host:path`. Shared by the Application's and the
 * Compose stack's source forms, which are one `CustomGitForm`.
 */
export const GIT_CLONE_URL =
  /^(?:(?:https?|ssh|git):\/\/(?:[^\s/?#@\\-][^\s/?#@\\]*@)?(?:[A-Za-z0-9][A-Za-z0-9.-]*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?\/[^\s\\]+|[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9.][A-Za-z0-9.-]*:[^\s\\]+)$/;

export const GIT_CLONE_URL_MESSAGE =
  "Give a clone URL: https://host/owner/repo.git, ssh://git@host/owner/repo.git or git@host:owner/repo.git";

/**
 * The branch a `git` source starts on when none is saved. It was a
 * placeholder, so the field looked filled and the save refused it as empty.
 * The same `main` a Project config's new `git` source is given
 * (`CUSTOM_GIT_BRANCH` in the backend's `service-settings.ts`).
 */
export const DEFAULT_GIT_BRANCH = "main";
