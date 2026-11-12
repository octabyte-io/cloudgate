/**
 * `deployment: ['create']`, which every lifecycle verb on an
 * Application asks for — Deploy, Redeploy, Restart, Start and Stop alike
 * (`ApplicationsService.start`/`stop`/`reload`, `DeploymentsController`), and
 * "Build now with saved settings" on a held build. Operating the
 * workload is deliberately not `service: ['update']` (`access-control.ts`), so
 * a role made to deploy but not to change keeps these live.
 */
export const APPLICATION_DEPLOY_REFUSAL =
  "Your role in this Organization cannot deploy, restart or stop this Application. Ask an owner or an admin to do it, or to change your role.";
