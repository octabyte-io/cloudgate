# A Compose stack in a Cloud account runs on its own Stack VM, made by OpenTofu and reached through the cloud's tunnel

Status: accepted (#1355). Supersedes the compose rule of [ADR-0063](0063-a-template-is-offered-only-where-its-deploy-target-can-make-every-entry-and-a-compose-part-needs-a-server.md) and the "Never in a Cloud account" consequence of [ADR-0069](0069-a-compose-stack-is-described-by-the-file-it-names-never-by-a-copy-of-it.md). Keeps [ADR-0035](0035-a-service-runs-on-a-server-or-in-a-cloud-account-fixed-when-it-is-created.md) whole. Amended by the owner's decision on #1359: a Stack VM's way out (Ubuntu's updates, Docker's packages, image pulls, the Session Manager endpoints) is a NAT gateway in the Environment network, with its Elastic IP and the private subnets' default route. The first Stack VM in an AWS Environment adds it, priced on its plan line from a coded rate table, and an Environment with no Stack VM keeps the network's idle cost; removing it with the last Stack VM is #1367's: as an Environment network nothing uses is removed by the plan after its last Service is gone, the plan after the last Stack VM's Delete finishes takes the NAT off with a network change, so a Delete that ends incomplete never leaves a Stack VM without its way out. The same holds on Google Cloud (#1362): the first Stack VM in a Google Environment adds a Cloud Router and its Cloud NAT to the Environment network, priced on its plan line. Amended by #1366 (the Cloud account's permissions): the Stack VM's role, its snapshots' role and its instance profile live under their own IAM path, `/cloudgate/stack-vm/`, which the task roles' grants do not reach; the deploy role may give them only the two AWS managed policies the definition attaches and no inline policy, and pass them only to EC2 and DLM, so the task roles' permissions boundary (ADR-0032) stays as it was. Its Stack VM statements are a second managed policy on the deploy role. A plan refuses a Stack VM in a Cloud account whose last check predates these permissions, naming what is missing. Amended by the owner's decision on #1372 (#1357 open point 1): the console's Compose stack create in a Cloud Environment asks for no Server; it writes the stack's row in the Cloud account and region, and the Environment's next plan makes its Stack VM, sized by the stack's console setting, never the stack itself, so ADR-0065's rule that a plan creates a console-managed Service only from a Pending setup stands. A stack already on a Server keeps its place.

Until now a cloud could not run a Compose stack, so a plan refused a `compose` entry in an Environment whose Deploy target is a Cloud account (ADR-0069), and a template with a compose part could be set up only where the Deploy target is a Server (ADR-0063). That shut every compose-based template, and every repository-described stack, out of Cloud Environments.

**Decided: a Compose stack whose place is a Cloud account and region runs on a VM of its own, the Stack VM, in that account and region and inside the Environment network. Cloudgate runs the stack there with `docker compose`.** This holds for every Compose stack, a template's compose part included.

## The decision

- **Place.** The stack's place is the Cloud account and region, as for a cloud `web` (ADR-0035). OpenTofu makes the Stack VM (ADR-0030), and it lives in the stack's own Infrastructure state (ADR-0036). It is never a Server row: it is not listed with Servers, nothing else can be deployed onto it, and on the hosted instance it counts only as part of its Cloud Environment (ADR-0048). The deploy engine's compose code runs the stack on it, as it does on a Server.
- **One per stack.** Each Compose stack has its own Stack VM, made by the plan that creates the stack and removed by its Delete. No VM is shared between stacks.
- **Reached through the cloud's tunnel.** The Stack VM has no public address and no open SSH port. Cloudgate reaches it through AWS Session Manager or Google IAP tunnelling, with SSH inside the tunnel, so the remote-execution layer still speaks SSH. The compose file, `.env` values and config files are decrypted only to be written over that tunnel (ADR-0015, ADR-0019). The Cloud account's setup template gains the session permissions, and the platform host carries the cloud's tunnel helper.
- **Machine.** A Size picks the smallest machine type at least as large in both CPU and memory, as for a cloud database. A stack with no size starts at `medium` (on AWS `t3.small`, on Google Cloud `e2-small`). A repository-described stack takes `size` from its config entry. A console-managed stack, every template stack included, has it as a console setting, and `template.yaml` may name a minimum size that setup starts from. An exact machine type goes in the cloud `native` block under ADR-0044; `native.docker` stays refused. A resize restarts the VM, and its plan line says so.
- **Image and Docker.** The cloud's official Ubuntu 24.04 LTS image. On first boot, cloud-init installs a Docker Engine and compose plugin version that Cloudgate pins, beside its OpenTofu pins. The image the VM was made from is recorded, and only an approved "replace VM" plan line moves it.
- **Only `docker-compose`.** `type: stack` (Swarm) is refused in a cloud, the plan naming the entry.
- **Builds.** A compose `build:` runs on the Stack VM itself, as part of `docker compose up --build`. It is never translated into the cloud's build service (ADR-0047).
- **Domains.** A compose service's Domain is a rule on the Environment network's load balancer pointing at the Stack VM's private address and port, with the cloud's certificate, under every rule of a cloud Domain. A Stack VM has no generated host: sslip.io is built from a Server's address. So a template Domain in a Cloud Environment starts with a host the user types at setup, and Cloudgate shows and checks the DNS records.
- **Data.** Named volumes live on a separate cloud disk (EBS, or a Google persistent disk) mounted as Docker's volume folder, so a replaced VM keeps them. It starts at 20 GB and only grows. The cloud snapshots it daily and keeps 7 days.
- **Upkeep.** Ubuntu installs security updates by itself and never reboots by itself. The cloud brings back a VM that dies (EC2 auto-recovery, Google automatic restart), and the containers' restart policy starts them on boot. An OS or Docker change is a "replace VM" plan line, and the data disk is kept. The stack page shows whether the VM is running.
- **Stop, Start, Restart, logs, terminal.** Stop stops the containers and then the VM, so a stopped stack pays only for its disk. Start starts the VM and then the containers. Restart restarts the containers only. Logs and the terminal go through the tunnel.
- **Cost.** The plan line that makes the VM shows a monthly price for the machine type in the region (hourly × 730), the disk and a snapshot estimate, read from the price source the plan already uses. A resize shows the old and new prices.
- **Delete.** It removes the VM, its load balancer rules and target, its security rules, its cloud identity and its daily snapshots. The data disk is kept as a named final snapshot, priced on the plan line, unless the Apply ticks "also delete its data", as for RDS and Cloud SQL. The plan line names the volumes (ADR-0069). The Infrastructure state goes only once everything in it is gone, and a Delete that cannot finish keeps the stack's row (ADR-0038).
- **Templates.** With this, a template with a compose part can be set up in a Cloud Environment. Its compose part reaches the template's own `postgres` over the Environment network. ADR-0063's rule that a template is offered only where its Deploy target can make every entry still stands; `compose` is now a kind every cloud can make.

## Why a VM, and not ECS, Fargate or Cloud Run

Translating a compose file into the cloud's container services loses what compose is for: named volumes, healthchecks, `depends_on`, `build:`. ADR-0069 already rejects translating compose at plan time, since the translation would be a guess the plan applies silently. A VM running `docker compose` runs the file as written.

## Why the Stack VM is not a Server

ADR-0035 says a Cloud account is never a Server and no code path treats one as a kind of the other. Registering the VM as a Server would have reused the most code, but it would make the stack's place a Server that lives in a cloud. A Delete or Stop would go to a Server row rather than the account. Another Service could land on it. The hosted plan would count it twice. Keeping the VM inside the stack's place ties its life to the stack and keeps ADR-0035 true.

## Considered options

- **Register the VM as a Server.** Rejected for the reasons above.
- **One VM per Environment, shared by its stacks.** Rejected: stacks would share CPU and disk, a resize would restart every stack, and the VM's life would hang on the last stack, like the Environment network's.
- **A Cloudgate agent on the VM, or a public SSH port allowed to the instance's address.** Rejected: an agent is a new program to ship and keep up, and a public port is an attack surface the cloud's own tunnel avoids.
- **Public IP and Traefik with Let's Encrypt on the VM.** Rejected: a second way of serving Domains inside one Cloud Environment.
- **A Cloudgate-published machine image, or the cloud's container OS.** Rejected: an image to publish in every region, or no compose plugin (Google's Container-Optimized OS).
- **Volumes on the boot disk, backed up by Volume backups.** Rejected: data would die with the machine.

## Consequences

- The Cloud account's setup template, its connect check and the platform host's install change, for the tunnel.
- What ADR-0063 took away comes back in a better form: a compose-based template runs in a Cloud Environment, all of it in the cloud.
- Other console-managed kinds (MongoDB and the rest) still cannot be made in a cloud. Whether they ever run on a VM is a separate decision.

## What reopens this ADR

- A cloud service that runs a compose file as written, volumes and builds included.
- Stack VMs costing so much that sharing one per Environment is worth the coupling.
