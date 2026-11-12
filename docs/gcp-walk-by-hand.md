# Walking Google Cloud by hand

**A walk costs about $0.10 an hour** while the databases are up, and well under
that before them. These are the prices in us-central1, read from Google's Cloud
Billing catalog on the first walk (2026-10-20):

| What | Price | While |
|---|---|---|
| The Environment network's two global forwarding rules (load balancer) | $0.025/h, about $18/month: both are inside the flat charge for a project's first five | from the first Apply to the Delete |
| The network, subnets, firewall rule, service connection policies, certificate map, self-signed certificate | $0 | always |
| `web` on Cloud Run (scales to zero) | requests only, a fraction of a cent | while called |
| Artifact Registry | storage, cents | while the Service lives |
| Secret Manager | the first six active versions free, then about $0.06/month each | while the Service lives |
| `pg-1` on Cloud SQL, `db-f1-micro`, zonal | $0.0105/h, plus 10 GB of storage at $0.17/GB-month | step 5 to the Delete |
| `redis` on Memorystore for Valkey, `CUSTOM_PICO`, one node | $0.0308/h | step 5 to the Delete |
| Each database's private addresses (Private Service Connect endpoints): one for Cloud SQL, two for Memorystore (primary and reader) | $0.01/h each, about $7.30/month each, plus $0.01/GB | with the database |
| Cloud SQL's private DNS zone, which Google makes with the first instance | $0.20/month | with the last Cloud SQL instance |

A walk takes **two to three hours** of wall time and costs **about $0.20**.
Most of that time is the wait for Google's subnet hold at the end of step 7,
when only the forwarding rules still bill. **A Delete forgotten at the end
costs about $18 a month** for the network alone, and about **$52 a month**
with both databases and their addresses. Step 7 is not optional, and the walk
is not finished until its checks come back empty.

**Step 10, the Worker, Private web service and Cron service walk, costs about
$0.08 for an hour** in an Environment of its own: its load balancer's
forwarding rules and one always-on worker pool instance, plus a few minutes
of Cron runs. **Forgotten, it costs about $50 a month**, most of it the worker
pool. Its own Delete check is not optional either.

This is the one check of the Google Cloud slices (Cloud Run, Cloud
SQL and Memorystore) that no automated suite can make. Google has no moto. The e2e
suites answer Google from a fake that replays the stored plan files. The
Google validate lane (`pnpm test:google-validate`) checks the definitions
against the pinned provider's schema, and nothing more. Only a real project
shows these things:

- a `web` answers;
- Cloud Run reaches a database through Private Service Connect with its
  certificate checked;
- an Environment's Delete leaves nothing billing.

Never do the walk from CI, and never in a project that runs anything else.
Cloudgate's role can act as any service account in a connected project
([ADR-0041](adr/0041-cloudgates-role-can-act-as-any-service-account-in-a-connected-project-so-a-project-of-its-own-is-asked-for-not-enforced.md)).

## When it is required

- once before slice 6's first release, and once before slice 7's;
- step 10 once before the first release that makes the Worker,
  Private web service and Cron service on Google Cloud;
- again before any release that changes:
  - the OpenTofu or Google provider version (`OPENTOFU_*` and
    `GOOGLE_PROVIDER_VERSION` in `deploy/install.sh`,
    `deploy/opentofu/.terraform.lock.hcl`);
  - a generated resource (`backend/src/cloud-accounts/gcp/definitions/`);
  - the role (`backend/src/cloud-accounts/gcp/deploy-role.ts`).

The walk re-records the stored plan files the e2e suites replay
(`backend/test/cloud-accounts/fixtures/{plans,applies}/google/`, see
"Re-recording the stored plans" below). The release workflow's Google
validate job refuses a release while any of them still carries the mark
`"not yet from a real project"`.

**Each walk is recorded as a comment on the release**, using the record at the
end of this page, and every resource it makes is listed on a ledger issue
before it is made (for the first walk).
A release whose walk failed a step is not shipped; the failure is a ticket.

## Before you start

- A Cloudgate install built from the commit being released, with OpenTofu and
  the Google provider installed by its own `install.sh`. You are an owner or
  admin of its Organization.
- A Google Cloud project used only for this, on a billing account you may
  spend on.
- **A budget alert first.** In **Billing → Budgets & alerts**, make a budget
  of $5 on the project, alerting at 50%, 90% and 100%. It needs the
  Billing Account Administrator or Costs Manager role on the billing account.
  A project owner alone cannot make one; the first walk's key could not, and
  the walk recorded that on its ledger.
- `gcloud`, signed in **as yourself, as the project's owner**. You play the
  operator: you run Cloudgate's setup script and make every check below.
  Cloudgate never uses your credentials.
- A DNS zone you can add records to, for a host such as `walk.<your zone>`.
- One region, used throughout. Below, `$REGION` is that region (the first
  walk used `us-central1`), `$PROJECT` the project id, and `$ENV` the
  Environment's id. Cloudgate's Google names carry a 12-character key of an
  id, not the id: `<net>` is the network's key (`cloudgate-<net>-net`), and
  `<svc>` a Service's (`cloudgate-<svc>`), both as the plan names them.

Write down what the project holds before you start (`gcloud services list
--enabled`, `gcloud compute networks list`), so the end can put it back.

## 1. Connect by federation, with exactly the role

1. In **Settings → Cloud accounts**, **Connect**, choose Google Cloud, and
   give a name and the project id.
2. Copy the **setup script** and run it in Cloud Shell (or anywhere `gcloud`
   is signed in as the owner). It turns on the APIs Cloudgate needs and makes
   five things:
   - a workload identity pool and an OIDC provider in it that trusts the
     Cloud account's own key (the JWKS is in the script, so no public issuer
     is needed);
   - the custom role `cloudgate_deploy_<id>`;
   - the deploy service account;
   - the project binding that grants it the role;
   - the binding that lets the pool's one subject act as that service account.

   Cloudgate never turns on an API itself. On a new project, the script must
   turn the APIs on before it reads the project number, because Cloud
   Resource Manager starts off.
3. Enter the provider's and the service account's names the script prints,
   and save.

**Passes when** the check passes and the Cloud account is saved, its
permissions current. Then confirm nothing wider was granted:

```bash
SA=cloudgate-deploy-<id>@$PROJECT.iam.gserviceaccount.com
gcloud projects get-iam-policy $PROJECT --flatten='bindings[].members' \
  --filter="bindings.members:serviceAccount:$SA" --format='value(bindings.role)'
# projects/$PROJECT/roles/cloudgate_deploy_<id> only
gcloud iam service-accounts get-iam-policy $SA
# roles/iam.workloadIdentityUser for principal://…/subject/cloudgate:<cloud account id> only
gcloud iam workload-identity-pools providers describe cloudgate-<id> \
  --location=global --workload-identity-pool=cloudgate-<id> \
  --format='yaml(attributeCondition,attributeMapping,oidc)'
# attributeCondition: assertion.sub == 'cloudgate:<cloud account id>'
```

From here to the end, **never add a permission to get past a step.** A
`PERMISSION_DENIED` anywhere below is a failure of the walk: the role is
missing a permission, and that is the finding.

4. Make a new Project and an Environment in it, and set the Environment's
   **Deploy target** to this Cloud account and `$REGION`. Saving checks that
   Cloud Run and Artifact Registry are offered in the region and creates
   nothing.

**Passes when** the Deploy target saves, and the picker on the Environment's
settings shows the Cloud account and region.

## 2. Deploy the sample `web`

Give the Project the same `web` as the AWS walk
(`docs/aws-walk-by-hand.md` step 2), or an image of your own built for
`linux/amd64` that listens on its `port`:

```yaml
version: 1

services:
  web:
    kind: web
    size: small
    source:
      image: nginxdemos/hello:0.4
    port: 80
    env: [WALK_GREETING]
```

1. **Check for changes.** The plan reads Google Cloud and shows two steps.
   - The Environment network: "$0/month for the network, about $18/month while
     idle for the load balancer". It has twelve creates: the network, the
     subnet, the fixed IP, two forwarding rules, the HTTP and HTTPS proxies,
     two URL maps, the certificate map, its self-signed default certificate
     and the map's entry.
   - The `web` create: its Artifact Registry repository, the Cloud Run
     service (`small → 1 CPU / 1 GB, CPU only during requests, 0–10
     copies`), its serverless network endpoint group, backend service and
     service account. Beside it, a note that it gets no Domain yet.
2. **Apply.** The network's Cloud run comes first (about a minute). Then the
   `web`'s Deployment:
   - pulls the image on the platform host;
   - applies only the repository;
   - pushes as `oauth2accesstoken` to
     `$REGION-docker.pkg.dev/$PROJECT/cloudgate-<svc>/service:<deployment id>`;
   - reads Google again and applies the rest;
   - waits for the revision to serve all traffic;
   - removes every older image (about three minutes in all).
3. Open the `run.app` address the Domains tab shows as its generated Domain.
4. On the `web`, give `WALK_GREETING` a value, save, and **Deploy**. The
   first value makes a Secret Manager secret, so the deploy stops before
   changing anything: "Google Cloud differs from what Cloudgate made: review
   the plan", naming the secret's creates. Its plan is the Environment's open
   plan. Apply it.
5. **Deploy** once more, changing nothing.

**Passes when**:

- both Deployments end done and the network card shows its **Fixed IP**;
- the `run.app` address answers;
- `curl http://<fixed IP>/` answers a redirect to HTTPS;
- the last deploy is image-only: one change, the image, and no plan to
  review;
- the variable is a Secret Manager secret that only the Service's own
  account can read;
- the repository holds only the live image: its index and that index's own
  manifests.

```bash
gcloud secrets list --project $PROJECT                # cloudgate-<svc>-WALK_GREETING, with labels
gcloud artifacts versions list --project $PROJECT --location $REGION \
  --repository cloudgate-<svc> --package service      # the live index and its manifests only
gcloud certificate-manager maps entries list --map cloudgate-<net>-certs
# cloudgate-<net>-default  PRIMARY  ACTIVE: the self-signed certificate is the map's main entry
```

## 3. Domain over HTTPS

1. On the `web`'s **Domains** tab, add `walk.<your zone>`.
2. Make the two records the tab shows at your DNS provider:
   - the authorization CNAME, `_acme-challenge.walk.<your zone>.` →
     `….authorize.certificatemanager.goog.`;
   - an `A` record pointing the host at the network's fixed IP. A bare name
     takes the same `A` record.
3. Wait. The status goes **Waiting for DNS → Checking → Live**. Each record is
   ticked once Cloudgate has seen it. Record how long the certificate took.

   **Expect about 40 minutes, not a few.** On the third walk
   (2026-10-22):
   - Google made its first authorization attempt 36 s before the records
     existed, because the CNAME's value only exists once the run has made the
     certificate. That attempt failed `CNAME_MISMATCH`, and Google did not try
     again for 38 minutes.
   - Records made → certificate `ACTIVE`: about 42 minutes.
   - For about 2 more minutes, some of Google's front ends still served the
     self-signed default certificate, so a fetch could fail verification.
   - Cloudgate asks once a minute for 30 minutes after the request, then
     about every 10 minutes, so the card read **Live** about 8 minutes after
     `ACTIVE`, 50 minutes after the records.

**Passes when** the Domain is Live and:

```bash
curl -sSI https://walk.<your zone>/      # 200
curl -sSI http://walk.<your zone>/       # a redirect to https://
curl -sv  https://walk.<your zone>/ 2>&1 | grep -i issuer   # Google Trust Services, not self-signed
```

Without a DNS name you control, the step is **not runnable**. Still check
what Cloudgate made:

- a third certificate-map entry for the host, `PENDING`;
- a Google-managed certificate in `PROVISIONING`;
- the URL map's host rule;
- the two records on the Domain card.

## 4. Read the Runtime log

Open the `web`'s **Logs** tab ("A few seconds behind") and call the
`run.app` address a few times.

**Passes when** each request's own output shows within a few seconds. Each line
starts with its copy and revision. Cloud Run's own messages are marked as such
and read as words: the revision being ready, an instance starting, the update
call. No line is `{}`, and none needed a refresh.

## 5. Stop, Start, Reload, and a hand change in the next plan

1. **Stop** the `web`. Its `run.app` address answers 503. **Reload** is refused
   while it is stopped.
2. **Start** it: it answers again within seconds. **Reload**: a new revision
   of the same image.
3. Set the copy range on its page (say 0–3).
4. Make a hand change, as the console's **Edit & deploy new revision** would:

   ```bash
   gcloud artifacts docker tags add $IMAGE:<live tag> $IMAGE:hand-fix
   gcloud run services update cloudgate-<svc> --region $REGION \
     --image $IMAGE:hand-fix --update-env-vars DEBUG=1
   ```

5. **Stop** the `web` again, then **Check for changes**.

**Passes when**:

- the plan lists the Cloud Run service under **Drift**, naming exactly
  `template.0.containers.0.env` (with `DEBUG`) and
  `template.0.containers.0.image` (`:hand-fix`);
- the plan does not list Stop's scaling, Reload's label, the copy range, or
  the console's `client`/`client_version` (`gcloud` here);
- **Apply: put Google Cloud back** finishes on the stopped service. Its new
  revision is ready, and the service stays stopped (manual scaling, 0
  copies);
- the next **Check for changes** finds nothing.

## 6. A `web` reading and writing a postgres on Cloud SQL and a redis on Memorystore

Add a `pg-1` and a `redis`, both with no size, so each is the smallest
machine, and wire the `web` to both:

```yaml
  pg-1:
    kind: postgres
    version: "17"

  redis:
    kind: redis
    version: "8"

  web:
    # …as above, with:
    env:
      - WALK_GREETING
      - DATABASE_URL: pg-1.url
      - DATABASE_CA: pg-1.ca
      - REDIS_URL: redis.url
      - REDIS_CA: redis.ca
```

No `user:` is needed. With none, `pg-1` gets the user `app_pg_1` and the
database `pg_1`: PostgreSQL refuses every role name that starts with
`pg_`, so the default puts `app_` before one, and a written `user: pg_…` is
refused at plan time. The first walk, before that, lost seven minutes to a
`pg_1` user.

Use an image whose page connects to both the way `docs/linking-a-database.md`
says:

- node-postgres with `ssl: { ca }`, from the URL's parts or with its
  `sslmode` taken off;
- ioredis with `tls: { ca }`.

It should report what it reached.

1. **Check for changes.** The network step adds the private link:
   - a `/24` subnet `cloudgate-<net>-psc`;
   - a service connection policy per kind;
   - Memorystore's firewall rule for TCP 6379 and 11000–13047.

   All four lines read $0/month. Cloud SQL's says "the private DNS zone Google
   makes for its databases' names with the first one is about $0.20/month".
   The other steps:
   - `pg-1`: `db-f1-micro, POSTGRES_17, Enterprise edition, encrypted
     connections only, its own CA, no public IP`, and its private address,
     about $7.30/month;
   - `redis`: `CUSTOM_PICO, VALKEY_8_0, 1 node, cluster mode off, no password:
     only this Environment's private network reaches it, over TLS with its own
     CA` (ADR-0042), and its two private addresses (primary and reader), about
     $14.60/month;
   - `web`: its four wired variables, named and never shown.
2. **Apply.** The link's network run comes first (about a minute). Then
   `pg-1`'s Cloud run (7–12 minutes) and `redis`'s (about 7). Last, `web`'s
   deploy.

**Passes when**:

- `web`'s page reports Postgres reached at the instance's `….sql-psc.goog`
  name, which resolves to its `10.64.16.x` address, over TLS with `ca` checked
  and the host name verified;
- `psql` at the `url`'s host, with `ca` as `sslrootcert` and
  `sslmode=verify-full`, connects (libpq checks the name with no dot, as
  Google reports it; see below);
- Valkey answers `PONG` at its `10.64.16.x` address through Cloudgate's own
  `url` (`rediss://10.64.16.x:6379`, no password), with `tls: { ca }`
  alone: no `servername`;
- the next **Check for changes** finds nothing;
- with your own credentials:

```bash
gcloud sql instances describe cloudgate-<id> \
  --format='yaml(settings.ipConfiguration,dnsNames,settings.userLabels)'
# no public IP; PSC on; two PSC names, the …sql-psc.goog one recorded by Google's automation
gcloud memorystore instances describe cloudgate-<id> --location $REGION \
  --format='yaml(authorizationMode,transitEncryptionMode,endpoints)'
# AUTH_DISABLED, SERVER_AUTHENTICATION, a PRIMARY and a READER address
gcloud compute addresses list --filter="region:$REGION"
# sca-auto-addr-… per address: Google's, with no label of Cloudgate's
```

### libpq `verify-full` at the `….sql-psc.goog` name

A `postgres`'s
`host` is set to the name exactly as Google reports it. This checks that
rule with libpq on an instance set up the way Cloudgate sets one up. It was
walked by hand with `gcloud` and the Cloud SQL API on 2026-10-26 in
`cloudgate-test-123`, us-central1. It used a copy of the network (Direct VPC
egress subnet, `/24` private-link subnet, a `google-cloud-sql` service
connection policy), two `db-f1-micro` POSTGRES_17 instances and a Cloud Run job
running `postgres:17-alpine`. It cost about $0.05 and took 30 minutes.

```bash
# gcloud has no flag for automatic DNS, so the instance is made through the API:
curl -X POST …/v1/projects/<project>/instances -d '{… "pscConfig": {"pscEnabled": true,
  "pscAutoDnsEnabled": true, "allowedConsumerProjects": ["<project>"],
  "pscAutoConnections": [{"consumerNetwork": "projects/<project>/global/networks/<env-net>",
  "consumerProject": "<project>"}]} …}'
gcloud sql instances describe <pg> --format='yaml(dnsName,dnsNames)'
```

- **Google reports the `….sql-psc.goog` name without a trailing dot.** The
  v1 and v1beta4 APIs agree:
  `1eefffcff90f.1idghei1xv0vf.us-central1.sql-psc.goog`
  (`recordManager: CLOUD_SQL_AUTOMATION`). The `….sql.goog.` name keeps its
  dot (`recordManager: CUSTOMER`, and in `dnsName`). Google's record in the
  `sql-psc.goog.` zone is an A record with a 30 s TTL.
- **The certificate carries both names, each spelled the way Google reports
  it:** `DNS:<id>.<hash>.<region>.sql.goog., DNS:<id>.<hash>.<region>.sql-psc.goog`.
- **libpq (`psql`)** with the instance's CA as `sslrootcert`:

| Host | `require` | `verify-ca` | `verify-full` |
|---|---|---|---|
| the name **as reported** (no dot) | connects | connects | **connects** |
| the name **with** a dot added | connects | connects | fails: `server certificate for "<…>.sql.goog." (and 1 other name) does not match host name "<…>.sql-psc.goog."` |
| the endpoint's IP (control) | connects | connects | fails |

  The URL form behaves the same. So the rule (the name exactly as
  reported) is right for both names. libpq needs the dot on `….sql.goog.` and
  refuses it on `….sql-psc.goog`.
- **node-postgres** (pg 8.23.1, Node 24) with `ssl: { ca }` connects at either
  spelling, and fails at the IP, as in §8.
- **Automatic DNS has to be on when the instance is made.** A first
  instance was made with `gcloud`, which left `pscAutoDnsEnabled: false`,
  though the API says new instances default to on. Automatic DNS was turned on afterwards with a patch, which took about 45 s.
  The name and the record then appeared, but the certificate kept
  only `….sql.goog.`. A restart did not change that, so `verify-full` failed
  at the `….sql-psc.goog` name in both spellings. Cloudgate's definition sets
  `psc_auto_dns_enabled` in the create.
- **Automatic DNS needs the Cloud DNS API.** With it off, the instance read
  `instanceAutoDnsStatus: AUTO_DNS_FAILED` and no zone was made. After the API
  was turned on, the status only changed after automatic DNS was turned off
  and on again. Cloudgate turns the API on when a project is connected
  (`deploy-role.ts`, version 2's APIs).
- **Deleting:** the instances took Google's endpoints, addresses and the
  `sql-psc.goog.` zone with them. Google then held the Direct VPC egress
  subnet, as in §8, so `walk1038-env-net` and its egress subnet were left for
  a later clean-up. Neither is billed.

## 7. Delete a database, then the Environment, and check that nothing billable is left

1. Take `pg-1` out of the config (and `web`'s links to it), **Check for
   changes**, and **Apply**, confirming `pg-1` by name. The plan's destroy
   line names the final backup it keeps (`<project>-<environment>-pg-1-final-<date>`),
   and the Delete takes it just before the destroy. **Passes when** the
   instance, its `sca-auto-addr-…` address and forwarding rule are gone, and
   so is the private DNS zone with the last instance; the link's subnet and
   policies stay; and the backup is kept, found by its description (step 11
   shows how), until you delete it by hand.
2. Remove the Domain's records at your DNS provider (the Delete lists them).
3. Delete the Environment. Note the time. It reads **Deleting**:
   - a network run takes every Domain off;
   - each Service is destroyed in its own run;
   - the network goes last.

   Google keeps a subnet that Cloud Run's Direct VPC egress used for an hour
   or two after the service is gone: its `serverless-ipv4-…` address stays.
   So expect **Delete incomplete**, naming the subnet and network Google
   still holds and when Cloudgate tries again. Cloudgate tries by itself about
   2 and 4 hours after. On the first walk:
   - Google released the address about 1¾ hours after the service went;
   - Cloudgate's first own try, two hours after the incomplete Delete, removed
     the subnet and the network;
   - the Delete finished about 2⅓ hours after it began.

**Passes when**:

- the Delete ends incomplete only on the subnet hold, and a retry later clears
  it without a hand. Record how long Google held the subnet;
- the label search Cloudgate runs at the end names nothing billable;
- every check below comes back empty:

```bash
gcloud run services list --region $REGION
gcloud artifacts repositories list --location $REGION
gcloud sql instances list
gcloud memorystore instances list --location $REGION
gcloud compute forwarding-rules list
gcloud compute addresses list
gcloud compute target-https-proxies list; gcloud compute target-http-proxies list
gcloud compute url-maps list; gcloud compute backend-services list
gcloud compute network-endpoint-groups list
gcloud certificate-manager certificates list; gcloud certificate-manager maps list
gcloud certificate-manager dns-authorizations list
gcloud network-connectivity service-connection-policies list --region $REGION
gcloud compute firewall-rules list --filter='name~^cloudgate-'
gcloud compute networks subnets list --filter='name~^cloudgate-'
gcloud compute networks list --filter='name~^cloudgate-'
gcloud dns managed-zones list
gcloud secrets list
gcloud iam service-accounts list --filter='email~^cloudgate-' # the deploy account only
```

Then put the project back:

- delete the Cloud account in Cloudgate;
- delete the pool (it stays soft-deleted for 30 days, at no charge), the
  role and the deploy service account;
- turn off every API the setup script turned on that was off before;
- delete the `default` network and its `default-allow-*` firewall rules
  that turning on Compute made, if the project had none before.

## 8. An existing Cloud SQL and Valkey through manual endpoints

This checks the route chosen
for a hand-made database: Cloudgate makes its own Private Service
Connect endpoints to the instance, and nothing is set to connect
automatically. It was walked once by hand with `gcloud` alone, with no
Cloudgate install, on 2026-10-26 in `cloudgate-test-123`, us-central1. It cost
about $0.05 and took 40 minutes. Repeat it when that route's definition
changes.

**Setup.** This copies the network definition by hand:

- an "Environment" network, peered with nothing, with:
  - a subnet `10.64.0.0/20` for Cloud Run's Direct VPC egress
    (`private-ranges-only`);
  - a private-link subnet `10.64.16.0/24`;
  - the `psc-redis-ports` egress rule.
- an "operator's" network holding the hand-made instances, in the same
  project. There was no second project, so the case of an instance in
  another project was **not walked**.
- the probes are Cloud Run jobs running the public `postgres:17-alpine`,
  `valkey/valkey:8-alpine` and `node:22-alpine` images, using pg 8.23.1 and
  ioredis 5.

### Cloud SQL: a manual endpoint

```bash
gcloud sql instances create <pg> --database-version=POSTGRES_17 --edition=ENTERPRISE \
  --tier=db-f1-micro --region=$REGION --enable-private-service-connect --no-assign-ip \
  --ssl-mode=ENCRYPTED_ONLY      # no --allowed-psc-projects: Google accepts an empty list
SA=$(gcloud sql instances describe <pg> --format='value(pscServiceAttachmentLink)')
gcloud compute addresses create <ep> --region=$REGION --subnet=<env-psc-subnet>
gcloud compute forwarding-rules create <ep> --region=$REGION --network=<env-net> \
  --address=<ep> --target-service-attachment=$SA
gcloud compute forwarding-rules describe <ep> --region=$REGION --format='value(pscConnectionStatus)'
```

- **Creating the instance took about 9½ minutes.** `allowedConsumerProjects`
  came out empty, with PSC on.
- **The endpoint stays `PENDING` until its project is on the allow list, even
  when that is the instance's own project.** It was still `PENDING` after
  6 minutes. In that time every `psql` connection to its address timed out,
  because the SYN gets no answer: no refusal and no TLS error.
- `gcloud sql instances patch <pg> --allowed-psc-projects=<project>` took
  36 s. The endpoint read `ACCEPTED` within 2 s of that, and connections
  worked at once. The instance did not restart.
- **libpq (`psql`) at the endpoint's IP:**

| `sslmode` | Result |
|---|---|
| `require` | connects: PostgreSQL 17.11, TLSv1.3. `inet_server_addr()` is Google's `192.168.0.9`, not the endpoint's address |
| `verify-ca` with the instance's CA | connects |
| `verify-full` | **fails**: the certificate's only name is `<id>.<hash>.<region>.sql.goog.` (the `recordManager: CUSTOMER` name in `dnsNames`), and it carries no IP |

- **node-postgres at the endpoint's IP.** pg 8.x treats `require` as
  `verify-full`:

| What the app passes | Result |
|---|---|
| the URL Cloudgate hands out, `postgres://…@<ip>:5432/…?sslmode=require` | **fails**: "unable to verify the first certificate" |
| the URL with `?sslmode=require&uselibpqcompat=true`, or `?sslmode=no-verify` | connects, with the certificate unchecked |
| parts with `ssl: { ca }` (what `docs/linking-a-database.md` says) | **fails**: "IP: 10.64.16.10 is not in the cert's list" |
| parts with `ssl: { ca, servername: '<id>.<hash>.<region>.sql.goog' }` | connects, with the CA and the name both checked |
| parts with `ssl: { ca, checkServerIdentity: () => undefined }` | connects, with the CA checked and the name not |

- So the endpoint's IP with `sslmode=require` reaches the database, but only
  with libpq's meaning of `require`. Cloudgate's own instances are reached by
  a name that the certificate carries (§6). An existing instance reached at an
  IP is not. A private DNS record for the `….sql.goog` name, pointing at the
  endpoint, was not tried in this walk; it is the next part.

### Cloud SQL: a private DNS record for the instance's own name

This checks the host
chosen: the instance's own `<id>.<hash>.<region>.sql.goog` name, recorded by a
private zone in the Environment network that points at the manual endpoint.
It was walked on 2026-10-26, on a fresh copy of the setup above (no
operator's network was needed, as Cloud SQL's PSC needs none). It cost about
$0.01 and took 20 minutes.

```bash
gcloud sql instances create <pg> … --allowed-psc-projects=<project>   # as above, with the list set
NAME=$(gcloud sql instances describe <pg> \
  --format='value(dnsNames[0].name)')   # the recordManager: CUSTOMER entry; ends in a dot
gcloud dns managed-zones create <zone> --dns-name="$NAME" --visibility=private \
  --networks=<env-net> --description="…"
gcloud dns record-sets create "$NAME" --zone=<zone> --type=A --ttl=300 --rrdatas=<ep ip>
```

- **With the allow list set at create, the endpoint read `ACCEPTED` 14 s
  after the forwarding rule was made.** The instance again took 9 minutes.
- **The instance reports the name with a trailing dot**, in both `dnsName`
  and `dnsNames[].name`: `4c583468c161.1idghei1xv0vf.us-central1.sql.goog.`.
  The certificate's only DNS name carries the same dot
  (`DNS:<id>.<hash>.<region>.sql.goog.`). Its CN is `<project>:<instance>`.
- The zone and its record took 2 s each. A Cloud Run job started about a
  minute later resolved the name to the endpoint's `10.64.16.10`.
- **libpq (`psql`)** with the instance's CA as `sslrootcert`:

| Host | `require` | `verify-ca` | `verify-full` |
|---|---|---|---|
| the name **without** the trailing dot | connects | connects | **fails**: `server certificate for "<name>." does not match host name "<name>"` |
| the name **with** the trailing dot (`<name>.`) | connects | connects | **connects** |
| the endpoint's IP (control) | connects | connects | fails, as above |

  The URL form behaves the same: `postgres://…@<name>:5432/…?sslmode=verify-full`
  fails, and `…@<name>.:5432/…` connects. libpq compares the names as
  strings, dot included.
- **node-postgres** (pg 8.23.1, Node 22), host the name:

| What the app passes | Result |
|---|---|
| the URL Cloudgate hands out, `postgres://…@<name>:5432/…?sslmode=require` | **fails**: "unable to verify the first certificate", the CA, not the name; the same as for Cloudgate's own instances (`docs/linking-a-database.md`) |
| that URL with `ssl: { ca }` | fails the same way: the URL's `sslmode` replaces the `ca` |
| that URL with `NODE_EXTRA_CA_CERTS` set to the CA | connects, with the name checked |
| the URL with `sslmode` taken off, plus `ssl: { ca }` | connects, with the CA and the name checked |
| parts with `ssl: { ca }` (what `docs/linking-a-database.md` says) | **connects**, with the CA and the name checked, no `servername` |
| parts with `ssl: { ca }`, host `<name>.` with the dot | connects |
| parts with `ssl: { ca }` at the endpoint's IP (control) | fails: "IP: 10.64.16.10 is not in the cert's list" |

  Node's name check ignores the trailing dot; libpq's does not.
- **Price**, from the Cloud Billing catalog (Cloud DNS, read 2026-10-26): a
  managed zone is **$0.20/month** for each of a billing account's first
  25 zones, $0.10/month from the 26th, $0.03/month past 10,000. Queries are
  $0.40 per million (a zone's first billion), then $0.20. Cloud SQL's own
  zone for Cloudgate-made instances (§6) counts toward the same 25.
- **Permissions**, from Google's Cloud DNS access-control page; a custom role
  holding only these was **not** tried live, since this walk made no service
  account. The next Google walk after the role gains them checks them:
  - the zone: `dns.managedZones.create`, `.get`, `.list`, `.update` and
    `.delete` on the zone's project;
  - the network binding: `dns.networks.bindPrivateDNSZone` on the project of
    each network the zone is bound to (here the same project). Google's DNS
    roles also hold `compute.networks.get`; the page does not say a private
    zone needs it;
  - the record: `dns.resourceRecordSets.create`, `.get`, `.list`, `.update`
    and `.delete`, each change also needing `dns.changes.create`, and
    `dns.changes.get` to read a change.
- **Deleting:** the record, then the zone, each in about a second, while the
  instance and endpoint still existed. Google then held the Direct VPC egress subnet, as at the end of
  the walk above.

### Valkey: two user-registered endpoints

The hand-made instance was:

- `shared-core-nano`, one node, `cluster-disabled`;
- `AUTH_DISABLED`, `SERVER_AUTHENTICATION`;
- created with automatic connections in the operator's network. That took
  about 5½ minutes;
- on maintenance version `MEMORYSTORE_20261008_00_00`, which is newer than
  the `MEMORYSTORE_20251210_02_00` that multiple networks need.

```bash
# both service attachments from describe: pscAttachmentDetails[].serviceAttachment
gcloud compute addresses create <vk-0> --region=$REGION --subnet=<env-psc-subnet>     # and <vk-1>
gcloud compute forwarding-rules create <vk-0> --region=$REGION --network=<env-net> \
  --address=<vk-0> --target-service-attachment=<…-psc-sa>                            # <vk-1>: <…-psc-sa-2>
gcloud memorystore instances update <vk> --location=$REGION --add-endpoints='[{"connections":[
  {"pscConnection":{"pscConnectionId":"<from the rule>","ipAddress":"<vk-0 ip>","network":"projects/<p>/global/networks/<env-net>",
   "forwardingRule":"projects/<p>/regions/<r>/forwardingRules/<vk-0>","serviceAttachment":"<…-psc-sa>"}},
  {"pscConnection":{… <vk-1>, "<…-psc-sa-2>"}}]}]'
```

- **Before registration**, the two forwarding rules read `PENDING`, and
  connections to them timed out.
- **The `forwardingRule` must be a relative name**
  (`projects/…/forwardingRules/…`). The full `https://www.googleapis.com/…`
  URL that `describe` prints for the automatic connections is refused with
  `INVALID_ARGUMENT`.
- **Registering took 1m42s.** The rules turned `ACCEPTED`. For about the
  first 40 s of that, new connections were reset during the TLS handshake.
  After that they answered `PONG`, about 45 s before the call returned.
- **Registering did not disrupt clients already connected.** These were:
  - one `valkey-cli` connection held open through the operator's automatic
    endpoint, sending `PING` every second;
  - a new connection opened every 3 s through that endpoint.

  Over the whole update, neither missed a beat or saw an error. The
  instance's uptime did not reset.
- **`describe` before and after.** Before: one `endpoints[]` entry with the
  two `pscAutoConnection`s. After: a second entry with two `pscConnection`s
  (`CONNECTION_TYPE_PRIMARY` and `CONNECTION_TYPE_READER`, each
  `pscConnectionStatus: ACTIVE`, on the Environment network), and a new
  `updateTime`. Nothing else changed.
- **The certificate is re-issued to carry the new addresses.** After
  registering, its SANs were `10.80.0.2, 10.80.0.3, 10.64.16.20, 10.64.16.21`,
  as both DNS and IP names. ioredis with `rediss://<primary ip>:6379` and
  `tls: { ca }` alone got `PONG`, `SET` and `GET`. No `servername` was needed,
  as in §6. The reader address resets connections while the instance has no
  replica.
- The server's `CLIENT LIST` shows the Cloud Run client's own subnet address
  (`10.64.0.x`) with `laddr` set to the endpoint address. Google applies no
  NAT.

### Deleting

- **Memorystore refuses to delete an instance while a registered connection's
  forwarding rule still exists**: `FAILED_PRECONDITION: some connections to
  be removed are still ACTIVE, please delete the forwarding rules first`. So
  an operator cannot delete their own Valkey while a Service still uses it
  through Cloudgate's endpoints.
- Once the two rules were deleted, the delete was accepted. `describe` still
  listed the two registered connections as `ACTIVE`. Whether an instance that
  is kept must have `--remove-endpoints` run on it was not walked.
- Cloud SQL's delete was not blocked by the manual endpoint. The endpoint was
  deleted first anyway.

### With Cloudgate: an existing Cloud SQL `postgres`

Walked once, on 2026-10-29 with role version 5 (the re-walk, below):
1–5, 7 and 8 passed; 6 (another project) was not walked. The steps above
were walked with `gcloud` alone; this one proves Cloudgate's own path and
the deploy role's endpoint and Cloud DNS permissions, which were taken from
Google's docs.

1. Update the deploy role from the setup script (version 5, which holds all
   of version 4 and the endpoint's Service Directory registration, since
   the re-walk), then **Check now** on the Cloud account.
2. Make an instance as in "a private DNS record" above, **without**
   `--allowed-psc-projects`. On `pg-1`'s plan row, **Use an existing
   database** with its connection name and the apps' login.
3. **Check for changes**: the plan refuses `pg-1`, naming the
   `gcloud sql instances patch … --allowed-psc-projects=<project>` command.
   Run it, then Check for changes again: the plan shows Cloudgate's
   endpoint (about $7.30/month) and private DNS zone (about $0.20/month).
4. **Apply**. The endpoint's Cloud run makes both with the deploy role
   alone; `pg-1`'s page shows no "not accepted" note.
   `gcloud compute forwarding-rules describe cloudgate-<key>-psc
   --region=$REGION --format='value(pscConnectionStatus,labels)'` reads
   `ACCEPTED` and carries Cloudgate's labels.
5. A `web` wired to `pg-1.url` and `pg-1.ca` connects with libpq
   `verify-full` at the `….sql.goog.` name, trailing dot included.
6. An instance **in another project**: grant
   `roles/cloudsql.viewer` there as the form shows, add this project to its
   allow list, and repeat 2–5; record whether the endpoint goes from
   `PENDING` to accepted.
7. Delete `pg-1`: only `cloudgate-<key>-psc` (address and rule) and the
   `cloudgate-<key>-sql` zone go; the instance is untouched.
8. Re-record `existing-postgres-create.json` from the real plan, as below.
9. **An existing MySQL**: repeat 1–4 and 7 with a `MYSQL_8_4`
   instance used as a `mysql`'s Existing database (`gcloud sql instances
   create … --database-version=MYSQL_8_4`, the rest as above). A Postgres
   instance named as a `mysql` refuses its plan, naming the engine. A `web`
   wired to its `url` and `ca` connects with mysql2 `{ ca, verifyIdentity:
   true }` at the `….sql.goog.` name as reported, and the `mysql` client
   with `--ssl-mode=VERIFY_IDENTITY` only with the trailing dot. Re-record `existing-mysql-create.json` from its plan.

   **Walked 2026-10-29: first stopped at 4, then passed on role
   version 5.** The first walk: the Postgres instance named as a `mysql`
   refused by engine, the empty allow list refused with its `gcloud sql
   instances patch` command, and the plan after the patch showed the
   endpoint and zone at the `….sql.goog.` name with its dot. Its Apply was
   refused by Google: making the endpoint's forwarding rule registers it in
   Service Directory (`servicedirectory.services.create` on
   `namespaces/goog-psc-default`; Google's message also names
   `servicedirectory.namespaces.create`), which role version 4 did not hold,
   and `no_automate_dns_zone` does not avoid it.

   The re-walk, the same day on role version 5, with fresh `db-f1-micro`
   instances made `--no-backup` (MySQL 8.4 and Postgres 17, about 12½
   minutes each, made side by side):

   - 2–3 as above for both: each empty allow list refused with its patch
     command, the patch took 21–22 s, and the plans showed the endpoint and
     zone.
   - 4: each endpoint's Cloud run took about 42 s with the deploy role alone.
     Each rule read `ACCEPTED` with Cloudgate's labels, each zone held one A
     record to its endpoint, and the pages showed the endpoint `ACCEPTED`
     with no note.
   - 5, MySQL: mysql2 `{ ca, verifyIdentity: true }` at the dotted name wrote
     rows 1 and 2 over TLS. The `mysql` 8.4 client with
     `--ssl-mode=VERIFY_IDENTITY` connected at `<name>.` (TLSv1.2) and failed
     at `<name>` with `certificate verify failed`.
   - 5, Postgres: node-postgres with `ssl: { ca }` at the dotted name wrote
     rows over TLSv1.3. `psql` `verify-full` connected at `<name>.` and failed
     at `<name>` with `server certificate for "<name>." does not match host
     name "<name>"`. The very first `psql` try, at `<name>.` from a Cloud Run
     job, timed out at a 10 s `connect_timeout`. A re-run with 30 s connected
     at once, twice, so this reads as a first connection, not the name.
   - 7: each Delete removed only the endpoint's address and rule and the
     zone. The audit log shows no write to either instance by the deploy
     service account, and each kept its settings version.
   - **Removing the database and a Service that links to it in one plan
     leaves the plan partly applied.** The database's destroy is refused,
     "cannot be deleted while a Service links to it … remove the link from
     the Project config and apply it first", though the same plan removes
     that Service. In a Cloud account the Service's Delete is a Cloud run
     that has not finished yet. Seen for `my-ex` with its `probe-my` cron and
     for `pg-ex` with `probe-pg`; a second Check for changes and Apply
     removed the database.
   - Service Directory in the audit log: a successful
     `compute.forwardingRules.insert` or `delete` lists only the compute
     permissions it checked. The registration Google makes as the caller
     appears only when it is refused, inside the compute entry's status, so
     the log cannot tell which of version 5's five `servicedirectory.*`
     permissions were used. The Service Directory API was off in the project
     throughout.

### With Cloudgate: an existing Valkey `redis`

Walked once, on 2026-10-29 with role version 5 (the re-walk): 1, 3–5,
7 and 8 passed; 2's refusals and 6 (another project) were not walked. It
proves Cloudgate's own path for the two user-registered
endpoints above and the deploy role's version 3, whose `redis.instances.get`
and `redis.clusters.get` were taken from Google's docs. A third,
`memorystore.instances.getCertificateAuthority`, was too, and Google refused
the whole role at create because no such permission exists (a walk on
2026-10-27): reading a Valkey instance's CA needs only
`memorystore.instances.get`.

1. Make an instance as in "Valkey: two user-registered endpoints" above. On
   the `redis` plan row, **Use an existing database** with
   `<project>/$REGION/<vk>`; the form asks for nothing else.
2. **Check for changes**: the plan shows Cloudgate's two endpoints, about
   $14.60/month together. Try each refusal once if time allows: an instance
   on a maintenance version below `MEMORYSTORE_20251210_02_00` (check that
   the `gcloud memorystore instances update … --maintenance-version=…`
   command the plan shows is accepted), and a Memorystore for Redis
   instance under the same name ("use Valkey").
3. **Apply**. The endpoints' Cloud run makes both with the deploy role
   alone. The cache's page shows "waiting for registration" and the
   `--add-endpoints` command; a `web` wired to `<redis>.url` and
   `<redis>.ca` deploys meanwhile.
4. Run the command exactly as shown. Record that Google accepts the relative
   forwarding-rule names and the `pscConnectionId`s as Cloudgate read them
   from `tofu`. **Check for changes**: the page no longer shows the command.
5. The `web` reaches it with `rediss://<primary ip>:6379` and `tls: { ca }`,
   and gets `PONG`, `SET` and `GET`.
6. An instance **in another project**: grant `roles/memorystore.viewer` there
   as the form shows, and repeat 1–5.
7. Delete the `redis`: only `cloudgate-<key>-psc-0` and `-psc-1` (addresses
   and rules) go; the instance is untouched. Record whether its
   `endpoints[]` still lists the two connections.
8. Re-record `existing-redis-create.json` (the plan and the apply's
   outputs) from the real run, as below.

**The re-walk of 2026-10-29**, with a `shared-core-nano` instance made with
automatic connections in an operator's network (5½ minutes, on
`MEMORYSTORE_20261008_00_00`):

- 2: the plan showed the two endpoints at about $14.60/month together. The
  Environment network's plan also added Memorystore's private link (its
  firewall rule and service connection policy, $0/month).
- 3: the endpoints' Cloud run took 1m22s. The page showed "waiting for
  registration" and the command; both rules read `PENDING`, and `web`
  deployed and answered `Connection is closed` for the cache meanwhile.
- 4: the command, run as shown, was accepted in 93 s with the relative
  forwarding-rule names and the `pscConnectionId`s Cloudgate read from
  `tofu`. Both rules turned `ACCEPTED`. The next Check for changes showed
  the cache registered, with no command.
- 5: `web` got `PONG`, `SET` and `GET` at the primary's address.
- 7: the Delete removed only the two addresses and rules. The instance kept
  its `updateTime`, and **its `endpoints[]` still listed both registered
  connections as `ACTIVE`** after the rules were gone. Memorystore then
  accepted the instance's own delete.
- The real service attachments name their tenant project by number
  (`projects/<number>/…/gcp-memorystore-auto-<id>-psc-sa`, `-psc-sa-2`).
  The stored files keep the sample names the specs use.

## 9. An existing Cloud Storage bucket in another project

Walked with a bucket in the Cloud account's **own** project only
(step 11); the key-reach test across projects is still not walked. It proves Cloudgate's lookup, the key it makes, and that a list made
with that key answers once the operator's grant is in place.

1. In a **second** project, make a bucket with no Cloudgate label:
   `gcloud storage buckets create gs://$BUCKET --project=$OTHER
   --location=$REGION --uniform-bucket-level-access`.
2. On `uploads`'s plan row, **Use an existing bucket** with `$BUCKET`. The
   form shows the `roles/storage.legacyBucketReader` grant for Cloudgate's
   service account. **Check for changes** before running it: the plan
   refuses `uploads`, naming the same command. Run it, then Check for
   changes again: the plan shows only `uploads`'s own service account and
   HMAC key, at $0/month, "used as given … in another project".
3. **Apply**. `uploads`'s page shows "Waiting for access" and the exact
   `gcloud storage buckets add-iam-policy-binding gs://$BUCKET
   --member=serviceAccount:cloudgate-<key>@$PROJECT.iam.gserviceaccount.com
   --role=roles/storage.objectUser` line. Run it and reload the page: the
   status turns to ok within a minute or two (record how long IAM took).
4. A `web` wired to `uploads`'s six Outputs puts, lists and fetches a
   presigned link on the newest S3 SDK, with no grant on the bucket of its
   own Service account.
5. Remove the grant and reload: the page says "No access" with the same
   line, and a plan and a deploy go through all the same.
6. **Rotate key**: the new key lists the bucket at once (the grant is on
   the account, not the key).
7. Delete `uploads`: the bucket and its files stay, `cloudgate-<key>` and
   its keys are gone (`gcloud storage hmac list --project=$PROJECT`), and
   the report names the `remove-iam-policy-binding` line; run it.
8. Re-record `existing-bucket-create.json` (plan and apply) as below.

## 10. A Worker, a Private web service and Cron services in one Project

**This walk costs about $0.08 for an hour.** **Forgotten, it costs about $50
a month.** Prices in us-central1, read from Google's Cloud Billing catalog on
2026-10-27 (Cloud Run and Cloud DNS SKUs, before any free tier):

| What | Price | While |
|---|---|---|
| This Environment network's two forwarding rules | $0.025/h, about $18/month (the top of this page) | from the first Apply to the Delete |
| `ticker`'s worker pool, 1 CPU / 512 MB, one instance | Worker Pools CPU $0.000011244/vCPU-s and memory $0.000001235/GiB-s: about $0.043/h, about $31/month | while it runs, not while stopped |
| `nightly`'s and `stuck`'s runs on Cloud Run jobs, 1 CPU / 512 MB | Jobs CPU $0.000018/vCPU-s and memory $0.000002/GiB-s: about $0.001 a minute of run | while a run executes |
| The private `run.app` zone | $0.20/month, queries $0.40 per million | from `inside`'s first plan to the network's Delete |
| `web` and `inside` on Cloud Run (scale to zero) | requests only, a fraction of a cent | while called |
| Artifact Registry, Secret Manager | as at the top of this page | while the Services live |

So an hour is about $0.025 + $0.043 + a cent of runs, **about $0.08**. A
forgotten Environment is about $18 + $31 + $0.20, **about $50 a month**,
nearly two thirds of it the worker pool, which bills while it runs whether
or not it does anything. A stopped Worker bills nothing for its pool. The
ticket's first guess of about $70 a month priced the worker pool at Cloud
Run's instance-based service rate ($0.000018/vCPU-s); the catalog's Worker
Pools rate is about 40% lower.

This is the Google twin of the AWS walk's four-kinds step
(`docs/aws-walk-by-hand.md` step 8), and the acceptance of the
spec for
its Worker,
Private web service
and Cron service.
It is required once before the first release that makes these kinds on
Google Cloud, and **again whenever their generated resources, the OpenTofu or
Google provider pins or the role change** (the three triggers of
[When it is required](#when-it-is-required)). It re-records their stored
plan files (see "Re-recording the stored plans").

Do it after step 1, with the Cloud account connected by the current setup
script (role version 5), and before step 7 puts the project back. Use a new
Environment of its own, its **Deploy target** this Cloud account and
`$REGION`. Below, `$ENV` is its id, `<net>` its network's key, and
`<ticker>`, `<inside>`, `<web>`, `<nightly>` and `<stuck>` each Service's key,
as the plan names them (`cloudgate-<key>`, the name of its worker pool,
Cloud Run service or job alike).

You need two images of your own, built for `linux/amd64` and pushed where
the platform host can pull them:

- **the `inside` image** answers HTTP on 4000 with a line naming its host
  (say `inside: <hostname>`);
- **the `web` image** serves on 8080. On each request it fetches
  `INSIDE_URL` and shows the reply on its page, printing
  `inside reply: …` (or `inside error: …`) to its Runtime log. A `web` on
  Cloud Run has CPU only during requests, so it cannot poll on a timer.

The Cron services use `curlimages/curl:8.10.1`, whose `curl` speaks HTTPS
and fails on a 404 with `-f`; `command: sh` replaces its entrypoint.

```yaml
version: 1

services:
  web:
    kind: web
    size: small
    port: 8080
    source: { image: <the web image> }
    env: [INSIDE_URL]

  ticker:
    kind: worker
    size: xsmall
    source: { image: busybox:1.36 }
    command: sh
    args: ["-c", "while true; do echo tick; sleep 5; done"]

  nightly:
    kind: cron
    source: { image: curlimages/curl:8.10.1 }
    command: sh
    args: ["-c", "curl -fsS \"$INSIDE_URL\" && curl -fsS -o /dev/null -w 'web: %{http_code}\\n' \"$WEB_URL\" && echo nightly ran"]
    schedule: "0 3 * * *"
    env: [INSIDE_URL, WEB_URL]

  stuck:
    kind: cron
    source: { image: busybox:1.36 }
    command: sleep
    args: ["120"]
    schedule: "0 3 * * *"
    timeout: 1m
```

`inside` is added in 3 below, to an applied network that has no `run.app`
zone yet, so the walk records the zone's add. A `web-private` has no Output
yet, so `INSIDE_URL` and `WEB_URL` are typed by hand once their addresses
are known.

### `mysql` on Cloud SQL

A `mysql` on Cloud SQL
is the fourth of that spec's kinds, and the last to ship. It is walked once
before the release that makes it, in this step's Environment, beside the
three above. **It adds about $0.05 an hour, and about $35 a month
forgotten**, read from Google's Cloud Billing catalog on the re-walk
(2026-10-29):

| What | Price | While |
|---|---|---|
| `my-1` on Cloud SQL for MySQL, `db-g1-small` (what `xsmall` plans), zonal | $0.035/h, plus 10 GB of storage at $0.17/GB-month: about $27/month | from 2's Apply to the Delete |
| Its private address (one Private Service Connect endpoint) | $0.01/h, about $7.30/month, plus $0.01/GB | with `my-1` |
| Cloud SQL's private DNS zone, which Google makes with the first instance | $0.20/month | with `my-1` |

So with `my-1` an hour of this step is **about $0.13**, and a forgotten
Environment **about $85 a month**.

Add `my-1` to the config above, and give `web` its `url` and `ca`:

```yaml
  my-1:
    kind: mysql
    size: xsmall

  web:
    # … as above, with:
    env:
      - INSIDE_URL
      - DATABASE_URL: my-1.url
      - DATABASE_CA: my-1.ca
```

The `web` image, on each request, also connects to `DATABASE_URL` with
mysql2 and `ssl: { ca: DATABASE_CA, verifyIdentity: true }`, runs
`CREATE TABLE IF NOT EXISTS visits (at TIMESTAMP)` and
`INSERT INTO visits VALUES (NOW())`, and shows and logs
`mysql rows: <count>, tls: <the session's Ssl_cipher>` (or `mysql error: …`).

**`my-1`'s plan shows**, in 2:

- `my-1 xsmall → db-g1-small (shared CPU, 1.7 GB, no SLA: for testing)` and
  `my-1 backups: 7 days, point-in-time recovery on`, with no restart mark;
- "Cloud SQL instance `my-1`: create, db-g1-small, MYSQL_8_4, Enterprise
  edition, TLS offered, not required, its own CA, no public IP, a private DNS
  name through the private link", and its private address at about
  $7.30/month.

Record its plan as `mysql-create.json` (and, if a recording `tofu` is used,
its apply's outputs; the e2e suite stands a postgres's in for them until
then).

**The `mysql` passes when**:

- `web`'s page shows `mysql rows: 1`, then `2` on a reload, with a TLS
  cipher named: the row is written over TLS with the certificate and its
  name checked;
- what Google holds says the same:

  ```bash
  gcloud sql instances describe cloudgate-<my-1> --project $PROJECT \
    --format='yaml(databaseVersion,settings.edition,settings.ipConfiguration.sslMode,settings.ipConfiguration.serverCaMode,settings.ipConfiguration.ipv4Enabled,settings.backupConfiguration.binaryLogEnabled,settings.deletionProtectionEnabled)'
  # MYSQL_8_4, ENTERPRISE, ALLOW_UNENCRYPTED_AND_ENCRYPTED, GOOGLE_MANAGED_INTERNAL_CA,
  # ipv4Enabled: false, binaryLogEnabled: true, deletionProtectionEnabled: true
  gcloud sql users list --instance cloudgate-<my-1> --project $PROJECT
  # my_1 only: Google lists no root. Inside, mysql.user holds root only at
  # localhost, 127.0.0.1 and ::1, so no root is reachable over the network
  # (the re-walk)
  ```

- `version: "9.7"`, `version: "8.0"`, `version: "8.4.3"` and `user: root`
  each refuse the plan by name before anything reaches Google;
- **Stop** patches it to `NEVER` with Stop's warning and no date, and
  **Start** back to `ALWAYS`, with no Cloud run for either;
- its **Backups** tab reads Cloud SQL's retention, window and backups;
- turning point-in-time recovery off with
  `native.gcp."google_sql_database_instance.database".settings.backup_configuration.binary_log_enabled: false`
  plans "restarts my-1 once: about 20 s offline", and its Apply restarts it
  once; taking the key out plans it back on with the same
  mark;
- the Environment's Delete keeps `my-1`'s final backup, named in the
  Delete's report, until it is deleted by hand:

  ```bash
  gcloud sql backups list --instance cloudgate-<my-1> --project $PROJECT
  gcloud sql backups delete <id> --instance cloudgate-<my-1> --project $PROJECT
  ```

### The walk

1. **The network's create with the zone, planned only.** In a second new
   Environment with the same Deploy target, paste the config above with
   `inside` (from 3) added, and **Check for changes**. The network step lists
   "Private DNS zone `run.app`: create, for this Environment's Private web
   services, about $0.20/month" beside its twelve creates. Record this plan
   as `network-create-run-app-zone.json`; **do not apply it**. Delete that
   Environment: nothing was made, so its Delete has nothing to destroy.
2. **Check for changes**, then **Apply**, in this step's Environment with the
   config above. The plan shows:
   - the network's twelve creates, and no `run.app` zone;
   - `ticker`: its repository, service account and **Cloud Run worker pool**
     at `1 CPU / 512 MB`, with "a worker pool takes no less than 1 CPU /
     512 MB, so the size was rounded up", "CPU always on", and its instance
     count 1; no NEG, backend service or Domain;
   - `nightly` and `stuck`: a repository, service account and **Cloud Run
     job** each, and no Cloud Run service and no scheduler;
   - `web`: as in the page's step 2, with `INSIDE_URL` named and never shown.

   Every Deployment ends done, and no Cron run starts. Record `ticker`'s plan
   and apply as `worker-create.json`, and `stuck`'s, which has no variable,
   as `cron-create.json`.
3. **Add `inside`**, and **Check for changes**:

   ```yaml
     inside:
       kind: web-private
       port: 4000
       source: { image: <the inside image> }
   ```

   The network step lists only the `run.app` zone's create and its two
   records, about $0.20/month. `inside` lists its repository, service account
   and Cloud Run service with internal-only ingress, and no NEG, backend
   service or Domain. Record the network's plan as `run-app-zone-add.json`
   and `inside`'s plan and apply as `web-private-create.json`. **Apply.**
4. **Wire the addresses.** `inside`'s Application card and Domains tab show
   its address, `https://cloudgate-<inside>-<project number>.$REGION.run.app`.
   Note `web`'s run.app address too (step 2's generated Domain). Give `web`'s
   `INSIDE_URL`, and `nightly`'s `INSIDE_URL` and `WEB_URL`, their values,
   and **Deploy** each, **one at a time**. A first value stops the deploy
   for its Secret Manager create, as in the page's step 2; Apply that plan
   before the next Deploy. An Environment holds one open plan, so a second
   stopped deploy replaces the first's, and the first has to be deployed
   again.

   **For about 1.5 to 3.5 minutes after `inside` was made**, calls from
   inside the Environment get 404, the same as from outside, then 200 for
   good: Google is still rolling out its settings, and no deploy waits for
   it. Record how long it took.
5. **Check for changes.** It finds nothing: no Google line and no **Drift**.

**The Private web service passes when**:

- `web`'s page shows `inside: <hostname>`, fetched from `INSIDE_URL`, and its
  **Logs** tab shows `inside reply: …` with no `inside error` line (once the
  404 window has passed);
- the same address from outside the Environment is refused (this machine
  counts):

  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' https://cloudgate-<inside>-<project number>.$REGION.run.app/   # 404
  ```

- `web`'s own run.app address still answers from outside (`curl -sS -o
  /dev/null -w '%{http_code}\n' <web's run.app address>` is `200`); from
  inside it is `nightly`'s `web: 200` line below;
- what Google holds says the same:

  ```bash
  gcloud run services describe cloudgate-<inside> --region $REGION \
    --format='yaml(metadata.annotations)'
  # run.googleapis.com/ingress: internal, run.googleapis.com/invoker-iam-disabled: 'true',
  # and run.googleapis.com/urls listing the <service>-<project number>.$REGION.run.app address
  gcloud dns managed-zones describe cloudgate-<net>-run-app \
    --format='yaml(dnsName,visibility,privateVisibilityConfig)'
  # run.app., private, bound to cloudgate-<net>-net only
  gcloud dns record-sets list --zone cloudgate-<net>-run-app
  # *.run.app. and run.app., A, 199.36.153.8–11 (plus the zone's own NS and SOA)
  gcloud compute network-endpoint-groups list --filter='name~cloudgate-<inside>'   # none
  gcloud compute backend-services list --filter='name~cloudgate-<inside>'         # none
  ```

**The Worker passes when** `ticker`'s **Logs** tab shows a `tick` line every
five seconds; **Stop** leaves its worker pool at 0 instances, with no "still
bills" warning, and **Start** brings it back to 1, with no Cloud run for
either; and the pool runs at the smallest size Google takes:

```bash
gcloud run worker-pools describe cloudgate-<ticker> --region $REGION
# manual scaling, 1 instance (0 after Stop, 1 after Start); CPU 1, memory 512Mi
```

That floor is measured, not assumed. The walk of 2026-10-27 made
`ticker`'s pool at 1 CPU / 512Mi, which Google accepted, and asked Google for
two smaller pools with validate-only creates: 0.5 CPU and 256Mi were each
refused with Google's own "not supported" error. So 1 CPU / 512 MB is the
smallest worker pool, and Cloudgate's rounding a smaller size up to it is
right. If a later walk sees Google take less, the size mapping in
`cloud-run-size.ts` and the plan note in `project-config/planner/cloud-run.ts`
change; record what it took.

**The Cron services pass when**:

- Run now on `nightly` gives a green run whose log shows `inside:
  <hostname>`, then `web: 200`, then `nightly ran`, ending `exit code 0`. A
  run within the 404 window ends red with curl's `404`; that is not the
  finding;
- Run now on `stuck` gives a red run ending `timed out after 1m`: its
  execution, named on the Run record, was cancelled by Cloudgate;
- **a schedule-only change** (set `nightly`'s `schedule` to `"30 3 * * *"`)
  plans as a Cloudgate setting with **no Google line**, and Apply makes no
  Cloud run;
- **a command-only change** (set `stuck`'s `command` to `/bin/sleep`) plans
  as one change on its job, its command. Record it as
  `cron-command-change.json` and apply it. Then **Deploy** `stuck` with
  nothing changed: its plan changes only the job's image. Record it as
  `cron-image-only.json`;
- what Google holds says the same:

```bash
gcloud run jobs describe cloudgate-<stuck> --region $REGION
# 1 task, parallelism 1, max retries 0, task timeout 24h (86400s), VPC egress private ranges only
gcloud run jobs executions describe <stuck's execution> --region $REGION
# cancelled, one task, not retried
gcloud run jobs executions list --job cloudgate-<nightly> --region $REGION
# one execution per Run now, none from the schedule change
gcloud run services list --region $REGION   # web and inside only: no Cron service is a service
gcloud scheduler jobs list --location $REGION   # none (or the API is off)
```

**The deploy role passes when** it is version 5 and holds exactly version 3's
permissions, version 4's 21 (for the four kinds) and version 5's 5 Service
Directory ones (the re-walk), with no
wildcard:

```bash
gcloud iam roles describe cloudgate_deploy_<id> --project $PROJECT \
  --format='value(description)'                      # Cloudgate deploy role, version 5
gcloud iam roles describe cloudgate_deploy_<id> --project $PROJECT \
  --format='value(includedPermissions)' | tr ';' '\n' | wc -l          # 252
gcloud iam roles describe cloudgate_deploy_<id> --project $PROJECT \
  --format='value(includedPermissions)' | tr ';' '\n' \
  | grep -E '^run\.(workerpools|jobs|executions|tasks)\.|^dns\.managedZones\.(get|set)IamPolicy$|^servicedirectory\.'
# run.workerpools.{create,get,list,update,delete,getIamPolicy,setIamPolicy}
# run.jobs.{create,get,list,update,delete,run}
# run.executions.{get,list,cancel,delete}
# run.tasks.{get,list}
# dns.managedZones.{getIamPolicy,setIamPolicy}
# servicedirectory.namespaces.{create,get}
# servicedirectory.services.{create,get,delete}
```

No `run.jobs.runWithOverrides`. Versions 4 and 5 ask for no API version 3
does not.
The rest of Cloud DNS's permissions are version 3's.

**The Private web service's Delete passes when**, after removing `inside`
from the config and applying (the `web`'s and `nightly`'s errors that follow
are expected), its Cloud Run service is gone and the zone stays:

```bash
gcloud run services list --region $REGION                    # no cloudgate-<inside>
gcloud dns managed-zones list --filter='name=cloudgate-<net>-run-app'   # still there
```

The next **Check for changes** leaves the network step unchanged: the zone
goes only with the network.

**The Environment's Delete passes when** it goes as in step 7: expect
**Delete incomplete** on the subnet Google holds for an hour or two after
Cloud Run's last service, worker pool and job are gone (its
`serverless-ipv4-…` address, as in step 7), cleared by Cloudgate's own retry.
Then run step 7's checks for this Environment, and these, which name nothing
of it:

```bash
gcloud run worker-pools list --region $REGION     # no cloudgate-<ticker>
gcloud run jobs list --region $REGION             # no cloudgate-<nightly> or cloudgate-<stuck>
gcloud run services list --region $REGION         # no cloudgate-<web> or cloudgate-<inside>
gcloud dns managed-zones list                     # no cloudgate-<net>-run-app
gcloud compute addresses list --filter='name~^serverless-ipv4'   # none, once the hold is over
```

Record how long Google held the subnet.

## 11. Buckets, a static site, backups and Stop

**This step costs about $0.15 for an hour and a half**, and about **$52 a
month forgotten** (the top of this page's network and databases), plus what
the Delete keeps. Prices in us-central1 (the walk of 2026-11-02, from the
plans' own lines):

| What | Price | While |
|---|---|---|
| The network, `pg-1` (`xsmall` plans `db-g1-small` here, $0.035/h) and `redis`, with their private addresses | as at the top of this page | from the Apply to the Delete |
| `uploads` and an existing bucket on Cloud Storage | storage and requests by use: cents | while they hold files |
| `docs`'s bucket and Cloud CDN backend bucket | $0/month fixed; serving by use | from its create to its Delete |
| `pg-1`'s final backup, kept by its Delete | about $0.80/month (the plan's own figure) | until you delete it |
| `redis`'s final backup, kept by the Environment's Delete | storage by use | until you delete it |

This is the acceptance of the Google Cloud bucket spec
and the twin of the AWS bucket walk for it. It is required once before slice 7's release, and
again on the three triggers of [When it is required](#when-it-is-required). It
re-records `bucket-create.json`, `existing-bucket-create.json` (plan and apply
each) and `static-create.json`.

Use one Environment, its Deploy target this Cloud account and `$REGION`:

```yaml
version: 1

services:
  web:
    kind: web
    size: small
    port: 8080
    source: { image: <an image that puts, lists and fetches a presigned link with the newest @aws-sdk/client-s3> }
    env:
      - S3_BUCKET: uploads.name
      - AWS_REGION: uploads.region
      - S3_ENDPOINT: uploads.endpoint
      - S3_FORCE_PATH_STYLE: uploads.path_style
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
      - DATABASE_URL: pg-1.url
      - REDIS_URL: redis.url
  pg-1: { kind: postgres, size: xsmall }
  redis: { kind: redis }
  uploads: { kind: bucket }
  docs:
    kind: static
    source: { git: <a repository with a dist/ folder holding index.html, about/index.html and assets/v1.css> }
    build: { publish: dist, spa: false }
```

The walk ran `mirror.gcr.io/library/node:22-alpine` with `command: sh` and
an `args` script that installs the SDK at start and serves the test, so no
image of its own was built (Docker Hub refused the plain `node:22-alpine` with
429 from a shared address).

1. **Check for changes**, then **Apply**. The plan shows `uploads`'s service
   account, bucket (`cloudgate-<key>-<8 random>`, soft delete off, uniform
   access, public access prevented), its `objectUser` binding and HMAC key;
   `docs`'s private bucket, Cloud CDN backend bucket and the load balancer's
   read access; `pg-1 backups: 7 days, point-in-time recovery on` with no
   restart mark. Record `uploads`'s plan and apply as `bucket-create.json` and
   `docs`'s plan as `static-create.json`.
2. **The bucket and the S3 SDK.** Open `web`'s `run.app` address: it puts,
   lists and fetches a presigned link. **This decides the checksum note**: if
   the SDK's default checksums fail, turn `BUCKET_CHECKSUM_NOTE_ON` on
   (`project-config/planner/plan-links.ts`). The walk saw all three pass on
   `@aws-sdk/client-s3` 3.1161.0, so the note stays off.

   ```bash
   gcloud storage buckets describe gs://<uploads bucket> \
     --format='yaml(soft_delete_policy,public_access_prevention,uniform_bucket_level_access)'
   # retentionDurationSeconds: '0', enforced, true
   gcloud storage buckets get-iam-policy gs://<uploads bucket>
   # roles/storage.objectUser for cloudgate-<key> only; no grant to web's own account
   ```

3. **An existing bucket.** Make one by hand (`gcloud storage buckets create
   gs://$BUCKET --location=$REGION --uniform-bucket-level-access`, a file in
   it), **Use an existing bucket** with it as `photos`, add `photos: { kind:
   bucket }` to the config, and Apply. The plan line reads "existing bucket
   `$BUCKET` in `$REGION`, used as given … $0/month". Record its plan and
   apply as `existing-bucket-create.json`. The page shows "Waiting for
   access" with the exact `add-iam-policy-binding` line; run it and reload
   (ok at once in the same project); remove it and reload ("No access", the
   same line); put it back. Step 9 is the same in another project.
4. **The static site.** **Deploy** `docs`: "Uploaded 3 files", "Copying into
   the live site", and "No Domain yet". Add two Domains (a host name that
   reaches the network's fixed IP works without a certificate, for example
   `docs.<fixed IP>.sslip.io`, and curl it with `-k`). Then:

   ```bash
   curl -sk https://$HOST/ https://$HOST/about/        # 200, the pages
   curl -sk -o /dev/null -w '%{http_code}' https://$HOST/about   # 404, no redirect
   curl -sk -D - -o /dev/null https://$HOST/assets/v1.css | grep -i cache-control
   # public,max-age=0
   ```

   Turn rollbacks on, deploy a second version that removes `v1.css`, then
   roll back to the first: each copies into `live/`, removes the old file and
   clears the cache once per Domain. Set `spa: true`: a network run, the plan
   noting that visitors may see the old behaviour for missing pages, then an
   unknown path answers the shell with 200 (about 2 minutes to spread). Set it
   back, remove one Domain, and take `docs` out of the config: its rules come
   off the network first, then its buckets go.
5. **Point-in-time recovery off.** On `pg-1`, set
   `native.gcp."google_sql_database_instance.database".settings.backup_configuration.point_in_time_recovery_enabled: false`.
   The plan marks "restarts pg-1 twice: about 15 s offline"; Apply it and read
   the restarts in Cloud SQL's own log:

   ```bash
   gcloud logging read 'resource.type="cloudsql_database" AND
     resource.labels.database_id="'$PROJECT':cloudgate-<pg-1>" AND
     (textPayload:"database system is shut down" OR textPayload:"ready to accept")' --limit 20
   ```

   The walk saw two shutdowns each way (about 13 s offline turning it off, about
   10 s turning it on): the mark's wording holds.
6. **Stop and Start.** **Stop** `pg-1`: its activation policy turns `NEVER`
   and it reads stopped, with no Cloud run. Stop on `redis` is refused with
   "Memorystore can't be stopped. Delete it to stop paying." While `pg-1` is
   stopped, a plan that changes it carries "pg-1 is stopped. Start it first."
   and its Apply is partly applied without starting it. **Start** it, wait for
   `RUNNABLE` (a plan read while it starts fails and asks for another Check),
   and apply the change.
7. **The Backups tab** reads Cloud SQL's retention (7), its backups and the
   console link, and Memorystore's (1 day). Its restorable window is empty
   while Google has none yet, as just after point-in-time recovery is turned
   on again.
8. **Delete `pg-1` and `photos`.** The plan names the backup it keeps. After
   the Apply:

   ```bash
   curl -s -H "Authorization: Bearer $(gcloud auth print-access-token)" \
     "https://sqladmin.googleapis.com/v1/projects/$PROJECT/backups" \
     | jq '.backups[] | {description, type, expiryTime}'
   # <project>-<environment>-pg-1-final-<date>, ON_DEMAND, no expiry; plus the
   # automated backups Cloud SQL keeps on delete, each expiring by its retention
   gcloud storage ls gs://$BUCKET                        # its file is still there
   ```

   The report names the line that removes the grant; run it. Once the key's
   service account is gone, Google lists the member as
   `deleted:serviceAccount:…?uid=…`, so the line reads the member from the
   bucket's policy and removes it by that name. `get-iam-policy`
   then shows no `roles/storage.objectUser` binding for it.
9. **Delete the Environment** as in step 7: it keeps `redis`'s final backup
   and `uploads` while it holds files, and names both. Then delete those and
   `pg-1`'s backups by hand, and run step 7's checks.

**Passes when** every check above holds and step 7's checks come back empty
apart from the kept backups and buckets the report names.

## Re-recording the stored plans

Run the walk with a recording `tofu` (a wrapper that runs the real binary and
copies each `tofu show -json` and `tofu output -json` beside the run's
`main.tf.json`). Then copy each real plan over its stored file in
`backend/test/cloud-accounts/fixtures/plans/google/`, and each apply's outputs
into `applies/google/`. Replace the `cloudgate_fixture` key with one naming
the walk, which plan it was, and what was masked (variable values and the
default certificate's key, never anything else). Then:

```bash
cd backend
npx jest test/cloud-accounts/google-plan-fixtures.spec.ts   # lists what is still marked
npx jest test/cloud-accounts/read-google-plan              # the readers against real plans
```

A stored file the walk had no real plan for keeps its mark, and the release
waits for a walk that makes one.

Step 10 re-records the files of the four-kinds spec's three kinds, each from the
plan the step names:

| Stored file | Kind | From step 10's |
|---|---|---|
| `plans/google/network-create-run-app-zone.json` | the network's create with the `run.app` zone | 1, planned only |
| `plans/google/worker-create.json`, `applies/google/worker-create.json` | Worker | 2, `ticker` |
| `plans/google/cron-create.json`, `applies/google/cron-create.json` | Cron service | 2, `stuck` |
| `plans/google/run-app-zone-add.json` | the zone added to an applied network | 3, the network |
| `plans/google/web-private-create.json`, `applies/google/web-private-create.json` | Private web service | 3, `inside` |
| `plans/google/cron-command-change.json` | Cron service | the command-only change to `stuck` |
| `plans/google/cron-image-only.json` | Cron service | the Deploy of `stuck` with nothing changed |
| `plans/google/mysql-create.json` | `mysql` on Cloud SQL | 2, `my-1` |

Step 11 re-records the bucket spec's, rewritten the same way to their
stored sample ids (`svc_bucket_1`, `state_bucket_1`, `svc_static_1`,
`state_static_1`, the existing bucket `acme-prod-uploads`), with the HMAC key
masked:

| Stored file | Kind | From step 11's |
|---|---|---|
| `plans/google/bucket-create.json`, `applies/google/bucket-create.json` | Bucket | 1, `uploads` |
| `plans/google/static-create.json` | Static site | 1, `docs` |
| `plans/google/existing-bucket-create.json`, `applies/google/existing-bucket-create.json` | Existing bucket | 3, `photos` |

Rewrite each to the sample ids and names its stored `cloudgate_fixture`
names (`svc_worker_1`, `svc_private_1`, `svc_cron_1` and their states), as
the first walk's files were, so the readers' specs still hold. The command
change keeps the walk's own command, `/bin/sleep`, which the Cron reader's
spec names. Step 10 also confirms the smallest size a
worker pool accepts, which the private-service proof could not measure: the walk of
2026-10-27 measured Google's floor at 1 CPU / 512 MB (CPU always allocated),
refusing 0.5 CPU and 256Mi as not supported, and Cloudgate rounds a smaller
size up to it.

## The record

Post this as a comment on the release:

```text
Google Cloud walk by hand — <release> (<commit>)
Who / when: <name>, <date>
Project / region: <project>, <region>
OpenTofu / Google provider: <from install.sh>   Role version: <n>
Why: first release | version change | generated-resource change | role change

0. Budget alert set ........................... yes/no (why)
1. Connect by federation, exactly the role .... pass/fail
2. Deploy the sample web ...................... pass/fail   (network <s>, web <m:s>, image-only <s>)
3. Domain over HTTPS .......................... pass/fail/not runnable   (time to Live: <m> min)
4. Runtime log ................................ pass/fail
5. Stop/Start/Reload, hand change put back .... pass/fail   (put back on a stopped service: <s>)
6. web reaches pg-1 and redis over TLS ........ pass/fail   (create took: pg-1 <m> min, redis <m> min)
   servername needed: Cloud SQL <yes/no>, Memorystore <yes/no>
7. a database's Delete removes its address .... pass/fail
   Environment Delete ......................... pass/fail   (incomplete for <h:m>, cleared by <retry>)
   nothing billable left ...................... pass/fail   (checks run at <time>)
10. Worker, Private web service, Cron services  pass/fail
   web reaches inside through run.app ......... pass/fail   (404 window after create: <m:s>)
   inside refused from outside ................ pass/fail
   public web answers inside and outside ...... pass/fail
   ticker's ticks; Stop 0, Start 1 instance ... pass/fail   (smallest pool Google took: <cpu / memory>)
   nightly green, reached inside and web ...... pass/fail
   stuck timed out after 1m, cancelled ........ pass/fail
   schedule-only change, no Google line ....... pass/fail
   role version 5, exactly the 21 + 5 new ..... pass/fail
   inside's Delete keeps the run.app zone ..... pass/fail
   Delete leaves no pool, job, service, zone .. pass/fail   (subnet held for <h:m>)
11. Buckets, static site, backups, Stop
   S3 SDK put/list/presign on Cloud Storage .... pass/fail   (SDK <version>; checksum note on/off)
   existing bucket: waiting → ok → no access .. pass/fail   (grant took <s>)
   static: deploy, 2 Domains, rollback, spa ... pass/fail   (spa spread <s>)
   static Delete: rules off, buckets gone ..... pass/fail
   PITR off restarts, as the mark says ........ pass/fail   (restarts <n>, offline <s>)
   Cloud SQL Stop/Start; Memorystore refused .. pass/fail
   pg-1's Delete keeps its backup ............. pass/fail   (found by description)
   stored plans re-recorded ................... <files>
Labels: <kinds that kept Cloudgate's labels>
Real cost: <$>, from the Billing report

Findings: <none, or a ticket each>
```
