# A Service runs on a Server or in a Cloud account, and its place is fixed when it is created

Status: accepted, extending the rule that each Service keeps its run Server. Built in parts: the Deploy target's cloud kind, then the Service's place.

Every Service has exactly one **place**: a run Server (or the platform host), or a **Cloud account** and a region. It is the Service's own, recorded on the Service when it is created, the cloud counterpart of `serverId`, and it never changes for the Service's life. Its logs, Stop, Restart, Delete and every later deploy go to that place. A Cloud account is never a Server, and no code path treats one as a kind of the other (`CONTEXT.md`, **Cloud account**).

An Environment's **Deploy target** is only the default for *new* Services: a Server, the platform host, or `{ kind: 'cloud', cloud account, region }`. The region is the Environment's, not the Cloud account's, so one Cloud account can serve two Environments in two regions. The Cloud account must belong to the Environment's Organization, checked the way `resolveDeployTarget` checks a Server. Choosing one also asks `cloudAccount: ['read']` on it.

**What a future change would be tempted to do, and must not:**

- **Read a Service's place from the Environment.** The Deploy target can change under a running Service. A Delete or a Stop that follows the Environment's current target reaches the wrong machine or the wrong account, which is the defect ADR-0018 exists to prevent. Ask the Service.
- **Put a kind the cloud cannot make on a Server instead.** One Environment may mix places: console-managed Services (Compose, MongoDB, …) are still created on the Server their creator names, and Services that ran there before a switch stay there. But a plan only ever creates where the Deploy target says. A Project config entry of a kind the Environment's cloud cannot make yet (in slice 3, anything but `web`; a `postgres` on RDS joined it later) **refuses the plan, naming the entry**. There is no fallback Server: it would quietly put a database on a VM while the operator thinks everything is in AWS.
- **Move a Service when the Deploy target switches.** A switch (to or from a cloud, or to another Cloud account or region) is allowed at any time and moves nothing. The next plan names each create's place. A plan made before the switch is refused at Apply, since it names the old place. Moving a stateless Service is taking it out of the config and putting it back: a Delete, then a create, with the downtime in between (a non-goal).

**Why not "no mixing":** it would break the rule that each Service keeps its run Server, and it would shut Compose and MongoDB out of any Environment with a cloud target.

**How the two kinds of place are served:** a Server by the deploy engine, a Cloud account by OpenTofu ([ADR-0030](0030-a-cloud-accounts-resources-are-made-by-opentofu-a-servers-by-the-deploy-engine.md)). Both write the same Deployment row and log (ADR-0007, ADR-0020). What a Service in a Cloud account made is kept in its **Infrastructure state** ([ADR-0036](0036-cloudgate-owns-the-infrastructure-state.md)).

**Consequences:**

- A Delete reclaims where the Service's place says (ADR-0018). In a Cloud account that is the recorded account and region, so a Cloud account cannot be deleted while any Service, Environment or **Environment network** still uses it.
- An Environment can leave an Environment network behind in an old Cloud account or region after a switch. It stays while a Service or the Deploy target is there, and goes with the Environment's Delete or the first plan that finds neither.
- Reaching a Server Service from a cloud one is the operator's concern in slice 3: a variable's value is typed in, unchecked. The slice that hands out connection URLs decides how one crosses.
- A Service's cloud place is two columns beside `serverId`, `cloudAccountId` and `region`, set together by the Apply that creates it; the `application_place` check keeps them both set or both null, and never set beside a Server. The Environment's Deploy target is the `cloud` arm of its `jsonb` column, checked in the region when it is chosen: the deploy role is simulated there, creating nothing.

**A Stack VM is not a Server** ([ADR-0070](0070-a-compose-stack-in-a-cloud-account-runs-on-its-own-stack-vm-made-by-opentofu-and-reached-through-the-clouds-tunnel.md)): a Compose stack in a Cloud account runs on a VM Cloudgate makes there for it alone. The stack's place is the Cloud account and region, the VM is in its Infrastructure state, and it is never a Server row, so this ADR's rule holds.

**What reopens this ADR:** a need to move a running Service between places in one step, or a cloud that can host every kind, so that the refusal no longer happens in practice.
