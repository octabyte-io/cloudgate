# A GPU reservation that cannot be met is refused, never left waiting

Status: accepted.

A **GPU reservation** is a whole number of cards per running copy of an Application, written as a Swarm `GenericResources` count (`DiscreteResourceSpec` `GPU`), on a Server whose **GPU setup** lists one named unit per card ID (`GPU=<uuid>`) rather than the older `GPU=<n>`. With the count form, a task reserving one GPU is handed card index 1, which a one-card Server doesn't have. Swarm's own answer to a reservation it can't meet is to leave the task `pending` and retry. **Cloudgate refuses instead.** A save asking for more cards than the run Server has, or made on a Server that doesn't qualify, is refused. A deploy reads free cards from Swarm before releasing (this Application's own current tasks count as free) and, if fewer than N × copies are free, fails the Deployment with "N GPUs needed, F of M free on <Server>". Nothing is released, and the old version keeps running.

**Considered options.**

- **Accept and wait**, Swarm's own behaviour, with "Waiting for a GPU" shown on the Overview (the first lean). Rejected, because a deploy would report success for a model that never starts, and a waiting task would grab the next card any other Service frees.
- **Start without a GPU.** Rejected by the PRD.
- **Card sharing** (MPS, time-slicing). Out of scope, since Swarm has none.

**Consequences, each of which looks like a bug without this ADR.**

- **Every Application with 0 GPUs, and every database, gets a platform-owned `NVIDIA_VISIBLE_DEVICES=void`** that the operator can't override, because GPU setup makes the nvidia runtime Docker's default, and a container that reserves nothing would otherwise see every card.
- **A Compose is neither kept off the cards nor refused on a GPU Server**, because its file is the operator's own: its containers can still see every card. A documented gap, not a guarantee (`CONTEXT.md`, GPU reservation).
- **An Application with 1 or more GPUs always updates and rolls back stop-first**, overriding any stored `UpdateConfig`/`RollbackConfig`, because start-first can never place on a Server that is exactly full. It costs a short outage on each deploy.
- **Cloudgate keeps no record of which card is held.** Swarm is the only record, so Stop and Delete free cards at once.
- **Changing the advertisement restarts Docker** on that Server (ADR-0013 for the platform host), so moving to the per-ID form is "run setup again", always confirmed, and never done by Cloudgate on its own.
- **"Waiting for a GPU" remains** only for a wait that begins outside a deploy (a reboot, a lost card). It is read from live Swarm state and is not a Deployment.

**What would falsify this.** Card sharing, a queue that operators actually ask for, or Swarm gaining device requests.

**Pinned by** the save refusal (`gpuReservationRefusal`), the free-card check before release and its own-tasks-count-as-free redeploy (`test/deployment-engine/deployment-engine.service.spec.ts`, "with a GPU reservation"), the reservation on the spec and forced stop-first (`test/deployment-engine/mechanize.spec.ts`, "a GPU reservation"), `void` on a reservation of 0, the refusal on a Server whose runtime cannot hand a task its card (`gpuReservationRefusal`), and the same pre-release check on a Rollback, Start and Restart (`test/rollbacks/rollbacks.e2e-spec.ts`, "a point with a GPU reservation"; `test/applications/application-gpus.e2e-spec.ts`, "starting and restarting"). The real-GPU walk confirms per-ID placement.
