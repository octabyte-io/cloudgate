/**
 * The CLI's exit codes, fixed by the accepted help text (CLI spec) so that
 * scripts can branch on them. Nothing else may be returned from a run.
 */
export const EXIT = {
  /** It worked (a Deployment ended done, or was queued with `--detach`). */
  ok: 0,
  /** It failed: the Instance refused, or a Deployment failed or was cancelled. */
  failed: 1,
  /** Wrong use: an unknown flag, or input missing with no one to ask. */
  usage: 2,
  /** Not logged in, or the login ended or was refused. */
  notLoggedIn: 3,
  /** Stopped with Ctrl-C. */
  interrupted: 130,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];
