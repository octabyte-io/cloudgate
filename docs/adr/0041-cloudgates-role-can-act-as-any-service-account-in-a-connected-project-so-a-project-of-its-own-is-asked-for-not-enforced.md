# Cloudgate's role can act as any service account in a connected Google Cloud project, so a project of its own is asked for, not enforced

Status: accepted, built as the role in `backend/src/cloud-accounts/gcp/deploy-role.ts`, the setup page's warning and the docs. Walked live.

Each Service in a Cloud account has an identity of its own there ([ADR-0032](0032-a-bucket-hands-over-the-same-outputs-on-every-target-and-on-a-cloud-its-access-is-the-services-own-role.md)). On Google Cloud that identity is a service account, which Cloudgate makes with the Service, names in the Cloud Run service's `service_account`, and deletes with it. To do that, Cloudgate's custom role holds `iam.serviceAccounts.create`, `get`, `list`, `update`, `delete` and **`actAs`**. Google cannot narrow these to the accounts Cloudgate made: IAM Conditions do not limit `actAs` by service-account name, and the accounts do not exist when the role is granted. So **the role can act as any service account in the project**, including the default Compute one, which holds the project-wide Editor role unless the operator removed that.

**Decided:** Cloudgate **asks** for a Google Cloud project used only by Cloudgate, and does not enforce it.

- The setup page says it plainly, beside the script: Cloudgate can act as any service account in the project, the default Compute one included, so use a project of its own.
- `docs/gcp-walk-by-hand.md` and the setup script's comments say the same.
- The connect check does **not** refuse a project that has other service accounts or other work in it. It checks only what Cloudgate needs: the federation, the role's permissions and the APIs.

**Why not enforce it.** No check can tell a project of Cloudgate's own from a project with other work in it:

- A new project already holds Google's own service accounts (the default Compute account appears as soon as the Compute API is on; the walk saw it). So "no other service account" would refuse every project.
- What else runs in a project (VMs, buckets, other teams' services) is not visible to a role that holds only what Cloudgate needs. Granting more, just to look, would widen the very role this is about.
- A check passing at connect says nothing about tomorrow: someone can add work to the project later, and Cloudgate would not notice.

A refusal that cannot be correct would only teach operators to work around it.

**Why not narrow the role instead.**

- **One shared service account for every Service.** This drops `create` and `delete` but keeps `actAs` on that one account. It breaks ADR-0032: a Service's bucket access would be every Service's.
- **Operator-made service accounts, one per Service, granted by name.** Each new Service would need the operator back in Cloud Shell, and a deploy from a push could not create a Service on its own.
- **Google's predefined roles.** They are wider still, and they move without a Cloudgate change.

**Consequences.**

- On Google Cloud, the "limit" ADR-0032 speaks of is the project boundary, not a permissions boundary as on AWS. It is weaker, and the docs say so. AWS's deploy role can create only roles under its own path, carrying its permissions boundary. Google has nothing like that.
- An operator who connects a shared project gives Cloudgate, and anyone who controls Cloudgate's key, the reach of every service account in that project. The setup page is where they are told, and the only place.
- The deploy service account holds one custom role on the project and nothing else. The federated principal holds only `roles/iam.workloadIdentityUser` on that one service account. So nothing besides `actAs` widens Cloudgate's reach beyond the role.

**What reopens this ADR:**

- Google adding a way to limit `iam.serviceAccounts.actAs` (or service-account creation) by name or by tag, through IAM Conditions or a principal access boundary that applies to impersonation;
- Cloudgate giving up a service account per Service on Google Cloud;
- an organization policy that Cloudgate could check without widening its role.
