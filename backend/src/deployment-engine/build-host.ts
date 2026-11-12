/**
 * Which machine an Application's *build* happens on, and therefore which
 * machine holds every artifact a build leaves behind.
 *
 * One rule, four modules (§1.4). `DeploymentEngineService.deploy` had it
 * inline as `application.buildServerId || application.serverId` and was the
 * only place that got it right; `RollbacksService` had a second copy of it
 * under a rollback-shaped name (`preservedImageServerId`, now delegating here);
 * and the two Delete paths had no copy at all — they ran their `rm -rf` on
 * `serverId`, so on a build-Server install the removal was issued to a machine
 * that had never held the directory, exited non-zero, and was swallowed by the
 * best-effort `catch` around it. ADR-0016's own lesson stated one artifact
 * along: two copies of a rule that has been wrong once is how it goes wrong
 * again, and no copy at all is how it was never right.
 *
 * **One of the callers is a *write*, and that is the point of stating the rule
 * rather than only fixing the deletes.** `ApplicationsService.uploadDrop`
 * unpacks a `drop` archive into the same `{appName}/code` the clone writes, and
 * it too reached for `serverId` — so the tree was written to the runner and
 * looked for on the builder, and once the delete was corrected the same
 * Application's tree would have been created on one machine and removed from
 * the other. Whoever creates an artifact and whoever destroys it have to answer
 * this question the same way, which is only guaranteed if it is one question.
 *
 * **`||` and not `??`, and that is the semantics rather than a defence against
 * nullish.** A `buildServerId` of `null` means *no dedicated build Server*, so
 * the build ran wherever the service runs, and the fall through to `serverId`
 * is the answer. An empty string reaches the same answer for the same reason —
 * it is not a `server` row's id either.
 *
 * **`null` is the platform host, per ADR-0008**, not "unknown": an Application
 * with neither column set builds and runs in this process's own Docker, which
 * is the default single-box install and the configuration every one of these
 * call sites is most often serving.
 *
 * **What this deliberately does not decide is where the *workload* runs.** That
 * is always `application.serverId` — the converge, the Swarm service, the
 * presence probe and the Traefik dynamic config all belong to the run Server,
 * and `applications/application-ops.ts` says so at its own head. The two
 * answers coincide on a single-Server install, which is exactly why a call site
 * that reached for the wrong one stayed green everywhere it was tested.
 *
 * A plain exported function rather than a method on `DeploymentEngineService`:
 * `common/service-cascade.ts`'s precedent and its stated reason — the callers
 * are `applications`, `common`, `preview-deployments` and `rollbacks`, and
 * asking a service for a `||` would point four modules at `DeploymentEngineModule`
 * for what is one expression over two columns.
 */
export function buildHostServerId(context: {
  serverId?: string | null;
  buildServerId?: string | null;
}): string | null {
  return context.buildServerId || context.serverId || null;
}
