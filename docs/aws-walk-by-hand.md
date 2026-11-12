# Walking AWS by hand

**A walk costs about $0.06** — an hour or less of one load balancer, one small
Fargate task and their public addresses. **A Delete forgotten at the end costs
about $36 a month** for as long as nobody notices: the Environment network's
load balancer alone is about $24 of it, idle. Step 6 is not optional, and the
walk is not finished until its checks come back empty.

**The databases add about $0.03 an hour** (steps
5b–5c and 7): about $0.02/h for the `db.t4g.micro` RDS instance and about $0.013/h for
the `cache.t4g.micro` ElastiCache node, plus the hand-made existing instance's
$0.02/h while it lives. **Each create takes 10–15 minutes**; plan the walk
around two of them. Forgotten, an RDS instance is about $15 a month and a
cache node about $10; the final snapshots step 6 keeps cost a few cents a
month each until you delete them, which step 6 ends by doing.

**The buckets and the `static` site cost next to nothing** (steps
5d–5e):
a few kilobytes in S3, a few requests through CloudFront, and a certificate
ACM issues free. A CloudFront distribution bills only what it serves. Step 6
keeps the `uploads` bucket because it holds a file, which is the point; it
costs a fraction of a cent until you delete it by hand at the end of step 6.

**The four kinds' walk costs about $0.10 more** (step
8): its
own Environment network, a `db.t4g.micro` RDS for MySQL instance and three
small Fargate tasks for under an hour, and **about 15 minutes more** for the
MySQL instance's create. Forgotten, the `mysql` is about $15 a month.

This is the one check of the AWS slice that no automated
suite can make. The e2e suites answer AWS from a fake, and the moto lane runs
the real `tofu` against an AWS stand-in that runs no container, routes no
request, validates no certificate and makes no network interface
(`docs/testing.md`, "The moto lane"). Only a real account shows
that a `web` answers on its Domain over HTTPS and that an Environment's Delete
leaves nothing billing.

Never do the walk from CI, and never against an account that runs anything
else that matters.

## When it is required

- once before slice 3's first release;
- step 8 once before the first release that makes the four kinds on
  AWS;
- again before any release that changes:
  - the OpenTofu or AWS provider version (`OPENTOFU_*` in `deploy/install.sh`,
    `deploy/opentofu/`);
  - a generated resource (`backend/src/cloud-accounts/aws/definitions/`);
  - a permission (`backend/src/cloud-accounts/aws/setup-template.ts`, which
    then carries a new policy version).

The moto lane must pass and its re-saved plans be committed first; the walk
does not replace it. For the databases the lane proves less than for a `web`
(`backend/test/cloud-accounts/moto/database-lane.moto-spec.ts`): moto has no
TLS, no real endpoint and no 7-day restart, and no cache parameter groups,
so it never applies a redis at all. Steps 5b, 5c and 7 are the only proof
of those. For the buckets and `static` sites the lane applies the
bucket, the site's distribution, its `us-east-1` certificate and a task role's
bucket access, and checks the object-storage adapter against moto and a Garage
container (`test/object-storage/*.moto-spec.ts`); but moto has no CloudFront
Functions, serves nothing, validates no certificate and times nothing, so
steps 5a, 5d, 5e and 7 are the only proof that a site answers on its Domain,
that a task role reaches its bucket, and how long CloudFront takes.

**Each walk is recorded as a comment on the release**, using the record at the
end of this page. A release whose walk failed a step is not shipped; the
failure is a ticket.

## Before you start

- A Cloudgate install built from the commit being released, with OpenTofu and
  the AWS provider installed by its own `install.sh` (`docs/deploy.md`). You are
  an owner or admin of its Organization.
- An AWS account you may spend in, ideally a sandbox account of its own. A
  billing alarm on it is cheap insurance.
- The AWS CLI, signed in **as yourself with read access to the account** — not
  with Cloudgate's key. Every check below is made with your own credentials, so
  it sees what Cloudgate's narrow role cannot.
- A DNS zone you can add records to, for a host such as
  `walk.<your zone>`.
- One region, used throughout. Below, `$REGION` is that region and `$ENV` the
  Environment's id (from its URL in the console).

## 1. Connect with exactly the minimum role

1. In **Settings → Cloud accounts**, **Connect**, with a name and the 12-digit
   account id.
2. **Download CloudFormation template** and create a stack from it, as it is,
   in any region (IAM is global). It makes the deploy role, the task execution
   role, the permissions boundary and an IAM user that can only take on the
   deploy role. Edit nothing in it.
3. In the IAM console, make an access key for the user the stack's
   `UserName` output names.
4. Enter the key and the stack's `DeployRoleArn` and `TaskExecutionRoleArn`
   outputs, and save.

**Passes when** the check passes and the Cloud account is saved, its
permissions current. Then confirm nothing wider was granted:

```bash
aws iam list-attached-role-policies --role-name cloudgate-deploy-<id>   # cloudgate-deploy-managed-<id> only
aws iam list-role-policies          --role-name cloudgate-deploy-<id>   # cloudgate-deploy-v<version> only
aws iam list-user-policies          --user-name cloudgate-<id>          # cloudgate-assume-deploy-role only
aws iam list-attached-user-policies --user-name cloudgate-<id>          # none
```

From here to the end, **never add a permission to get past a step.** An
`AccessDenied` anywhere below is a failure of the walk: the template is missing
an action, and that is the finding.

5. Make a new Project and an Environment in it, and set the Environment's
   **Deploy target** to this Cloud account and `$REGION`. Saving checks the
   deploy role in the region and creates nothing.

**Passes when** the Deploy target saves. A refusal names the region and the
denied actions.

## 2. Deploy the sample `web`

Give the Project, kept in Cloudgate, the sample config's `api` entry
(`backend/test/project-config/cloudgate.sample.yaml`, the shape the moto lane
plans) with a public image in place of the sample's placeholder repository:

```yaml
version: 1

services:
  api:
    kind: web
    size: small
    source:
      image: nginxdemos/hello:0.4
    port: 80
    env: [WALK_GREETING]
```

1. **Check for changes.** The plan reads AWS ("reading AWS…") and then shows the
   Environment network as its own step, "about $24/month while idle", and the
   `api` create with its AWS lines, the size beside Fargate's CPU and memory, and
   a note that it gets no Domain yet.
2. **Apply.** The network's Cloud run comes first, as a Deployment of the
   network on the Environment's Services tab; then the `api`'s Deployment pulls
   the image on the platform host, pushes it to the Service's own ECR
   repository, applies, and waits for the task to be steady.
3. On the `api`, give `WALK_GREETING` a value, save, and **Deploy**. A changed
   variable counts as image-only, so the deploy applies without a plan; its log
   says the variables changed and the tasks will be replaced, naming no value.

**The image's `HEALTHCHECK`**.
A `web` on ECS runs its image's `HEALTHCHECK` beside its target group's HTTP
check, as Docker runs it on a Server, so a task that fails either is replaced.
Its test, interval, timeout, retries and start period are copied into the
container definition's `healthCheck`, with Docker's defaults for what the image
leaves out (30 s, 30 s, 3 retries, no start period) and a value outside ECS's
range brought to its nearest end. `HEALTHCHECK NONE`, or no `HEALTHCHECK`,
adds nothing; `nginxdemos/hello` has none. Cloudgate reads it from the image
each deploy builds, so **an existing `web` gets its check with its next
deploy**, in the task definition revision that deploy writes: upgrading
Cloudgate shows no plan line, starts no rollout of its own and reports no
Drift. To see what a deploy registered:

```bash
aws ecs describe-task-definition --region $REGION --task-definition cloudgate-<service id> \
  --query 'taskDefinition.containerDefinitions[0].healthCheck'   # null when the image has none
```

**Passes when** both Deployments end done, their logs read like a Docker
deploy's, the network card shows its load balancer's DNS name, and the `api`'s
**Made in AWS** card lists its resources. Confirm the variable is a
SecureString and nothing else holds it:

```bash
aws ssm describe-parameters --region $REGION \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/cloudgate/$ENV/"
```

## 3. Open its Domain over HTTPS

1. On the `api`'s **Domains** tab, add `walk.<your zone>`.
2. Make the two records the tab shows at your DNS provider: the certificate's
   validation CNAME, and the CNAME pointing the host at the load balancer.
3. Wait. The status goes **Waiting for DNS → Checking → Live**; checking can take
   up to 30 minutes. Each record is ticked once Cloudgate has seen it.

**Passes when** the Domain is Live and:

```bash
curl -sSI https://walk.<your zone>/       # 200, from the nginxdemos page
curl -sSI http://walk.<your zone>/        # a redirect to https://
curl -sv  https://walk.<your zone>/ 2>&1 | grep -i 'issuer'   # Amazon, not self-signed
```

## 4. Read the Runtime log from the running task

Open the `api`'s **Logs** tab ("A few seconds behind") and curl the Domain a
few times.

**Passes when** each request appears as an nginx access line within a few
seconds, the line naming its task, and nothing on the tab needed a refresh.

## 5. Change something in the AWS console and see it in the next plan

1. In the EC2 console, add an inbound rule to the `api`'s security group
   (`cloudgate-service-<id>`): TCP 22 from `0.0.0.0/0`. This is the hand change
   the moto lane makes, now in a real account.
2. **Check for changes.**

**Passes when** the plan lists it under **Drift**, apart from any config
change, naming the rule; the plan stays open; **Apply: put AWS back** removes
the rule (check the security group); and the next **Check for changes** finds
nothing.

### 5a. A `static` site's CloudFront function

moto has no CloudFront Functions API, so the static moto lane never makes the
viewer-request function; only AWS proves it. Add `docs: { kind: static, source:
… }` to the config and Apply.

**Passes when** the plan listed the bucket, Origin Access Control, bucket
policy, function and distribution; in the CloudFront console the function
`cloudgate-<id>` is published and associated with the distribution on viewer
request; the bucket has Block Public Access on and a policy naming only that
distribution; and changing the distribution's *Default root object* by hand
shows under **Drift** on the next **Check for changes** while its origin path
never does. Then set the origin's *Origin access* to *Public* by hand (its
Origin Access Control taken off, which moto cannot show): the next
**Check for changes** lists the distribution under **Drift**, and its Apply
puts the OAC back. Uploading files comes later, so the site serves nothing yet.

### 5b. A `web` reading and writing a postgres on RDS and a redis on ElastiCache

Add a `pg-1` and a `redis` to the config, both with no size so they are the
smallest RDS class and ElastiCache node type, and a `web` wired to both. Any
image that reads and writes both will do; this one writes a row and a counter
at every start, prints what it read back to its Runtime log, and then serves
a page:

```yaml
  pg-1:
    kind: postgres
    version: "17"
    database: walk
    user: walk

  redis:
    kind: redis
    version: "8"

  web:
    kind: web
    size: small
    source:
      image: postgres:17-alpine
    command: sh
    args:
      - -c
      - >-
        apk add --no-cache valkey-cli busybox-extras &&
        psql "$DATABASE_URL" -c 'create table if not exists walk (at timestamptz)' &&
        psql "$DATABASE_URL" -c 'insert into walk values (now())' &&
        echo "postgres rows: $(psql "$DATABASE_URL" -Atc 'select count(*) from walk')" &&
        echo "redis counter: $(valkey-cli -u "$REDIS_URL" incr walk)" &&
        mkdir -p /www && echo walk > /www/index.html && httpd -f -p 80 -h /www
    port: 80
    env: [{ DATABASE_URL: pg-1.url }, { REDIS_URL: redis.url }]
```

1. **Check for changes.** The plan shows `pg-1` and `redis` as their own Cloud
   runs: `pg-1 no size → db.t4g.micro (2 vCPU, 1 GB) (smallest)`, its storage,
   backups and version; `redis no size → Valkey on cache.t4g.micro (2 vCPU,
   512 MB) (smallest)`, its snapshots and version; and `web` with its two
   wired variables, named and never shown.
2. **Apply.** `pg-1`'s and `redis`'s Cloud runs go first, 10–15 minutes each;
   `web`'s waits for both, then deploys.
3. **Deploy** `web` once more, so it starts a second time.

**Passes when** `web`'s Runtime log shows `postgres rows: 1` and
`redis counter: 1` from the first start and `postgres rows: 2` and
`redis counter: 2` from the second, with no TLS or authentication error in
between; the next **Check for changes** finds nothing; and, with your own
credentials:

```bash
aws rds describe-db-instances --region $REGION \
  --query "DBInstances[?TagList[?Key=='cloudgate:environment' && Value=='$ENV']].[DBInstanceIdentifier,PubliclyAccessible,StorageEncrypted,DeletionProtection]"
# one row: cloudgate-<id>, False, True, True
aws elasticache describe-replication-groups --region $REGION \
  --query "ReplicationGroups[].[ReplicationGroupId,TransitEncryptionEnabled,AtRestEncryptionEnabled,AuthTokenEnabled]"
# cloudgate-<id>, True, True, True
```

### 5c. An Existing database, deployed without creating an instance (ADR-0033)

1. Make an RDS for PostgreSQL instance by hand, outside the Environment
   network so it never stands in the way of step 6's Delete, and with a login
   of your own:

   ```bash
   aws rds create-db-instance --region $REGION \
     --db-instance-identifier walk-existing --engine postgres --engine-version 17 \
     --db-instance-class db.t4g.micro --allocated-storage 20 \
     --master-username walk --master-user-password '<a password>' \
     --db-name walk --no-publicly-accessible --tags Key=Team,Value=walk
   ```

2. Add a `pg-2: { kind: postgres, version: "17" }` to the config and
   **Check for changes**. On `pg-2`'s create step, **Use an existing
   database**: identifier `walk-existing`, the login and database above, and
   tick **I made it reachable from this Environment** (it is in another VPC,
   which Cloudgate cannot check).
3. **Check for changes** again, and **Apply**.

**Passes when** the plan says `pg-2: existing database walk-existing,
PostgreSQL 17.x, at walk-existing.….rds.amazonaws.com:5432; used as given,
Cloudgate changes nothing in it`, with no create of an instance, a subnet group
or a security group; the Apply runs no Cloud run for `pg-2`; `pg-2`'s page shows
the address it found; and `aws rds describe-db-instances --region $REGION`
lists `walk-existing` and the `cloudgate-<id>` from 5b, nothing more. Then, on
`pg-2`'s page, change the identifier to `walk-missing` and **Check for
changes**: the plan is refused, naming `walk-missing`, the Cloud account and
the region. Put `walk-existing` back.

### 5d. A `static` site answers on its Domain from CloudFront

moto serves no request and validates no certificate, so the static moto lane
proves the plan and nothing that answers. Give 5a's `docs` a real source with
an `index.html` at the root of its publish folder and a `guide/index.html`:

```yaml
  docs:
    kind: static
    source:
      github: <a repository of yours>
    build:
      publish: dist
      spa: false
```

1. **Deploy** `docs`. Its log uploads the files to a folder of their own,
   switches the distribution to it, clears CloudFront's cache of `/*`, and
   waits: `✅ [Spread] Deployed after …` and `✅ [Clear] Cache cleared after …`.
2. On its **Domains** tab, add `docs.<your zone>`. Make the two records the
   tab shows: the certificate's validation CNAME and a CNAME of the host to
   the distribution's `*.cloudfront.net` name. Wait for **Live**.
3. Change `index.html`, push, and **Deploy** again. Note both times its log
   prints.

**Passes when**:

```bash
curl -sSI https://docs.<your zone>/            # 200, x-cache from cloudfront
curl -sS  https://docs.<your zone>/guide/      # guide/index.html, by the function
curl -sSI https://docs.<your zone>/missing     # 404, never 403
curl -sv  https://docs.<your zone>/ 2>&1 | grep -i issuer   # Amazon
aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='docs.<your zone>']"  # one, ISSUED, in us-east-1 whatever $REGION is
curl -sSI https://<docs bucket name>.s3.$REGION.amazonaws.com/deployments/  # 403: only CloudFront reads the bucket
```

and the second deploy's page is the one served within the time its log
printed. Then **record what the spec's open research asked**:

- **Invalidation time**: the `Cache cleared after …` of both deploys, and the
  `Deployed after …` beside it.
- **In-flight invalidation limits**: what **Service Quotas → CloudFront**
  shows for *File invalidation: Maximum number of paths in progress* and
  *File invalidation: Maximum number of wildcard paths in progress* in this
  account. Cloudgate makes one `/*` per deploy, so the wildcard one is what a
  burst of deploys would meet.
- **Which distribution arguments force a replacement**: for each change this
  walk makes to the distribution — 5a's hand change to the default root
  object, a `spa: true` deploy, adding and removing the Domain — whether the
  plan reads *change* or *replace*. Only a *change* is expected; a *replace*
  is a finding, since a new distribution has a new `*.cloudfront.net` name the
  Domain's CNAME no longer points at.

### 5e. A `web` writes to and reads from its `bucket` through its task role (ADR-0032)

Add a bucket and a `web` linking all six of its Outputs, as
`docs/linking-a-bucket.md` writes them. This image writes a file, reads it
back, and says whether a key reached it, then serves a page:

```yaml
  uploads:
    kind: bucket

  files:
    kind: web
    size: small
    source:
      image: alpine:3.20
    command: sh
    args:
      - -c
      - >-
        apk add --no-cache aws-cli busybox-extras &&
        aws configure set default.s3.addressing_style
        "$( [ "$S3_FORCE_PATH_STYLE" = true ] && echo path || echo virtual )" &&
        echo "walk $(date)" > /tmp/walk.txt &&
        aws s3 cp /tmp/walk.txt "s3://$S3_BUCKET/walk.txt" --region "$AWS_REGION" --endpoint-url "$S3_ENDPOINT" &&
        echo "read back: $(aws s3 cp "s3://$S3_BUCKET/walk.txt" - --region "$AWS_REGION" --endpoint-url "$S3_ENDPOINT")" &&
        echo "key variables: ${AWS_ACCESS_KEY_ID:+set}${AWS_ACCESS_KEY_ID:-unset}" &&
        echo "presigned: $(aws s3 presign "s3://$S3_BUCKET/walk.txt" --region "$AWS_REGION" --endpoint-url "$S3_ENDPOINT" --expires-in 900)" &&
        mkdir -p /www && echo files > /www/index.html && httpd -f -p 80 -h /www
    port: 80
    env:
      - S3_BUCKET: uploads.name
      - AWS_REGION: uploads.region
      - S3_ENDPOINT: uploads.endpoint
      - S3_FORCE_PATH_STYLE: uploads.path_style
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
```

**Passes when** the plan shows `uploads` as an S3 bucket in the account
regional namespace and `files` with the note that on AWS the task's role gives
access for both key variables; `files`'s Runtime log shows `read back: walk
…` and `key variables: unset`; and, with your own credentials:

```bash
aws iam list-role-policies --role-name cloudgate-<files id>      # cloudgate-buckets
aws iam get-role-policy --role-name cloudgate-<files id> --policy-name cloudgate-buckets
# objects on arn:aws:s3:::<uploads name>/* and listing on the bucket, nothing else
aws ssm describe-parameters --region $REGION \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/cloudgate/$ENV/" \
  --query "Parameters[].Name"                                     # no …/AWS_ACCESS_KEY_ID, no …/AWS_SECRET_ACCESS_KEY
```

Then the existing-bucket lookup, whose found look moto cannot run
(`MOTO_MISSING`; the bucket lane runs the missing one): make `aws s3api create-bucket --bucket walk-existing-<your
initials> --region $REGION --create-bucket-configuration
LocationConstraint=$REGION` by hand, add `archive: { kind: bucket }`, and on
its create step **Use an existing bucket** with that name. **Check for
changes** shows it found, used as given, with no create. Then change the name
on its page to one no bucket of the account has: the plan is **refused naming
the bucket, the Cloud account and the region**, not failed with an OpenTofu
error such as "Iteration over null value" (that is a finding). Remove
`archive` from the config, and delete the bucket by hand.

`backend/test/cloud-accounts/fixtures/plans/existing-bucket-lookup.json` is
this found look as real `tofu show -json` prints it, since the moto lane cannot
re-save it. When the walk runs because the OpenTofu or AWS provider version
changed, record it again: plan `existingBucketLookup` (from
`aws/definitions/existing-bucket-lookup.ts`) in `eu-west-1` for a bucket
tagged `Team=shop` that also has a second bucket whose name starts with its
own. Then, in the stored file, name them `acme-prod-uploads` and
`acme-prod-uploads-archive`, write the account as `123456789012` and every
time as `2026-01-01T00:00:00Z`, and change nothing else.

### 5f. A Worker on ECS

Add a worker whose command prints a line every few seconds:

```yaml
  ticker:
    kind: worker
    source: { image: busybox:1.36 }
    command: sh
    args: ["-c", "while true; do echo tick; sleep 5; done"]
```

Its plan lists an ECR repository, log group, task definition, task role,
security group and ECS service, and **no target group, listener rule or
Domain**. Apply it.

**Passes when** its Deployment ends done, its **Logs** tab shows `tick` lines,
its security group has no inbound rule, and its ECS service has no load
balancer:

```bash
aws ec2 describe-security-groups --region $REGION \
  --filters Name=group-name,Values=cloudgate-service-<ticker id> \
  --query 'SecurityGroups[0].IpPermissions'          # []
aws ecs describe-services --region $REGION --cluster <cluster arn> \
  --services ticker-<ticker id> --query 'services[0].loadBalancers'   # []
```

Then set its `args` to `["-c", "exit 1"]` and apply: the Deployment **fails,
quoting the stopped task's reason** in its log. Remove `ticker` from the
config; its Delete goes with the Environment's in step 6 otherwise. A Worker
reads as healthy while it runs, which is not the same as working
(`docs/running-a-worker.md`, "On AWS").

### 5g. A Private web service reached by private DNS

Add a `web-private` and a `web` that calls it. The `web-private` answers on 4000 and has a `HEALTHCHECK`, so it is listed only once it listens:

```yaml
  inside:
    kind: web-private
    port: 4000
    source: { github: <your fork of a small HTTP server with a HEALTHCHECK on 4000> }
```

Set the calling `web`'s variable to `INSIDE_URL=http://inside.cloudgate.internal:4000` and list `INSIDE_URL` under its `env:`.

Its plan's network step lists **`Private DNS namespace \`cloudgate.internal\`: create, … about $0.50/month`**, and the `web-private`'s own lines list a discovery service, **no target group, listener rule or Domain**. Apply it.

**Passes when** the `web-private`'s Deployment ends done, the `web` shows a reply it fetched from `INSIDE_URL`, the `web-private`'s security group lets in only 4000 from `10.80.0.0/16`, and its ECS service has no load balancer and one service registry:

```bash
aws ec2 describe-security-groups --region $REGION \
  --filters Name=group-name,Values=cloudgate-service-<inside id> \
  --query 'SecurityGroups[0].IpPermissions'    # 4000/tcp from 10.80.0.0/16 only
aws ecs describe-services --region $REGION --cluster <cluster arn> \
  --services inside-<inside id> \
  --query 'services[0].[loadBalancers,serviceRegistries]'   # [[], [{registryArn: …}]]
aws servicediscovery list-namespaces --region $REGION \
  --query "Namespaces[?Name=='cloudgate.internal']"   # one per Environment network
```

From outside the VPC, `curl http://inside.cloudgate.internal:4000` does not resolve. Then remove `inside` from the config and apply: its discovery service goes, and **the namespace stays** (`list-namespaces` still shows it, and the next plan's network step is unchanged). It goes with the network in step 6.

### 5h. A Cron service run as one-off ECS tasks

Add two Cron services, one that finishes and one that overruns its `timeout`:

```yaml
  nightly:
    kind: cron
    source: { image: busybox:1.36 }
    command: sh
    args: ["-c", "echo nightly ran; exit 0"]
    schedule: "0 3 * * *"
  stuck:
    kind: cron
    source: { image: busybox:1.36 }
    command: sleep
    args: ["120"]
    schedule: "0 3 * * *"
    timeout: 1m
```

Each plan lists an ECR repository, log group, task definition, task role and security group, and **no ECS service and no scheduler**. Apply it: each Deployment ends done, and **no task starts** (`aws ecs list-tasks --cluster <cluster arn>` is empty).

**Passes when** Run now on `nightly` gives a green run whose log shows `nightly ran` and ends `exit code 0`; Run now on `stuck` gives a red run ending `timed out after 1m`, its task stopped (`aws ecs describe-tasks … --query 'tasks[0].stoppedReason'` is `Stopped by Cloudgate`); and a change to `schedule` alone plans as a setting with no AWS line and applies with no Cloud run. Neither has an ECS service:

```bash
aws ecs list-services --region $REGION --cluster <cluster arn>   # no nightly-… or stuck-…
```

They go with the Environment in step 6.

## 6. Delete the Environment, and check that nothing billable is left

Before deleting, note the network's VPC id and load balancer from the network
card, and the `api`'s resources from its **Made in AWS** card: they are what
the checks below must no longer find.

1. Remove the Domains' records at your DNS provider, the `api`'s and 5d's
   `docs`'s (the Delete lists them).
2. Delete the Environment. It reads **Deleting** while the `api`'s destroy-only
   Cloud run and then the network's run go, and then it is gone.
   The `docs` site from 5a goes in its own run: its bucket is emptied
   first, old versions included, and destroyed with no question about its
   files. CloudFront disables a distribution before deleting it, so that run
   takes several minutes.

   `pg-1` and `redis` from 5b each go in a Cloud run of their own:
   the Delete asks whether to keep their data, and the walk keeps it, so the
   run lifts the instance's deletion protection, names the final snapshot
   `<project>-<environment>-pg-1-final-<date>` (and `…-redis-final-<date>`),
   and destroys. `pg-2` is an existing database: only Cloudgate's records of it
   go, with no snapshot and no question about its data.

   `uploads` from 5e holds `walk.txt`, so the Delete keeps it: the
   Delete names it, with its account and region, as left behind, and no
   Cloud run destroys it. `files` goes like the `api`, its task role and its
   bucket access with it.

A **Delete incomplete** Environment fails the walk: record its _Left_ list,
**Retry**, and if anything is still left remove it by hand before going on.

**The databases pass when**, in the AWS console in `$REGION`, **RDS →
Databases** lists only `walk-existing`, **RDS → Snapshots → Manual** lists
`<project>-<environment>-pg-1-final-<date>` and no other snapshot Cloudgate
made, **ElastiCache → Valkey caches** lists none of this Environment's, and
**ElastiCache → Backups** lists `<project>-<environment>-redis-final-<date>`
alone. The same from the CLI:

```bash
aws rds describe-db-instances --region $REGION \
  --query "DBInstances[].DBInstanceIdentifier"                       # walk-existing only
aws rds describe-db-snapshots --region $REGION --snapshot-type manual \
  --query "DBSnapshots[].DBSnapshotIdentifier"                       # …-pg-1-final-<date>
aws elasticache describe-replication-groups --region $REGION \
  --query "ReplicationGroups[].ReplicationGroupId"                   # no cloudgate-<id>
aws elasticache describe-snapshots --region $REGION \
  --query "Snapshots[].SnapshotName"                                 # …-redis-final-<date>
aws rds describe-db-subnet-groups --region $REGION \
  --query "DBSubnetGroups[?starts_with(DBSubnetGroupName,'cloudgate-')]"     # []
aws elasticache describe-cache-subnet-groups --region $REGION \
  --query "CacheSubnetGroups[?starts_with(CacheSubnetGroupName,'cloudgate-')]" # []
aws elasticache describe-cache-parameter-groups --region $REGION \
  --query "CacheParameterGroups[?starts_with(CacheParameterGroupName,'cloudgate-')]" # []
```

The tag search below may list the final snapshots, which carry the tags of
what they keep: they are the only thing Cloudgate leaves on purpose, and
nothing else of the databases' may be listed. The kept `uploads` bucket is
listed too, for the same reason, and nothing else of the buckets'. Once the
checks pass, delete both snapshots, `walk-existing` and `uploads`
(`aws s3 rb s3://<uploads name> --force`) by hand.

**Passes when** every check below, with your own credentials, comes back empty.
AWS's tag index can trail a delete by some minutes; re-run a check that still
lists something before calling it a failure.

```bash
# everything Cloudgate tags, by its Environment
aws resourcegroupstaggingapi get-resources --region $REGION \
  --tag-filters Key=cloudgate:environment,Values=$ENV

# network interfaces, which AWS makes and no tag search finds
aws ec2 describe-network-interfaces --region $REGION \
  --filters Name=vpc-id,Values=<vpc id>
aws ec2 describe-vpcs --region $REGION --vpc-ids <vpc id>          # not found

# the billable things by name, in case a tag never landed
aws elbv2 describe-load-balancers --region $REGION \
  --query "LoadBalancers[?VpcId=='<vpc id>']"                          # []
aws ecs list-clusters --region $REGION                              # no cloudgate-$ENV
aws ecr describe-repositories --region $REGION                      # no cloudgate/<id>
aws logs describe-log-groups --region $REGION --log-group-name-prefix /cloudgate/$ENV/
aws ssm describe-parameters --region $REGION \
  --parameter-filters "Key=Name,Option=BeginsWith,Values=/cloudgate/$ENV/"
aws acm list-certificates --region $REGION                          # no walk.<your zone>, no default certificate
aws ec2 describe-addresses --region $REGION                         # no address Cloudgate left

# the static site's bucket and CloudFront resources
aws s3api head-bucket --bucket <docs bucket name>                  # 404, not found
aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='cloudgate/docs']"         # []
aws cloudfront list-origin-access-controls \
  --query "OriginAccessControlList.Items[?starts_with(Name,'cloudgate-')]" # []
aws cloudfront list-functions \
  --query "FunctionList.Items[?starts_with(Name,'cloudgate-')]"       # []
aws acm list-certificates --region us-east-1 \
  --query "CertificateSummaryList[?DomainName=='docs.<your zone>']"   # [], 5d's certificate went with the site

# the bucket that holds a file, kept and named: the one thing left on purpose
aws s3api head-bucket --bucket <uploads name>                      # found, in $REGION
aws s3 ls s3://<uploads name>/                                     # walk.txt

# the Service's task role, which no tag search finds either
aws iam list-roles --path-prefix /cloudgate/
```

Then put the account back: delete the Cloud account in Cloudgate (it names what
stays in AWS, which is yours), then the CloudFormation stack and the access
key.

## 7. The same config on a Server

This costs nothing in AWS and may run at any time. It shows that one Project
config carries both Deploy targets: on a Server, `pg-1` and `redis` are
containers and their URLs are plain (`postgresql://…` with no `sslmode`,
`redis://…`), where on AWS they asked for TLS. `uploads` is its own Garage
container (ADR-0037) with a generated HTTPS Domain, and `files` reaches it
with the bucket's key, through the same six Outputs.

1. Make a second Environment in the same Project, its **Deploy target** a
   Server of the Organization.
2. Change nothing in the config: `pg-2`, an existing database in the AWS
   Environment only, is one more container here. **Check for changes**,
   then **Apply**.
3. **Deploy** `web` once more.
4. Copy the `presigned:` URL from `files`'s Runtime log and, from your own
   machine, `curl -sS '<that URL>'`.

**Passes when** the plan shows `pg-1` and `redis` as containers on the
Server, with no Cloud run and no AWS line, `pg-2` included; `web`'s Runtime log shows
`postgres rows: 1`, `redis counter: 1`, then `2` and `2` after the second
deploy; and nothing new appeared in the AWS account (5b's checks list nothing
for this Environment's id). For the bucket, the plan shows
`uploads` as a Garage container on the Server with a generated Domain and no
AWS line; `files`'s Runtime log shows `read back: walk …` and `key variables:
set`; its `presigned:` URL is on the bucket's Domain (`https://<generated
host>/…`), not an internal address; and the `curl` of it from outside prints
the same `walk …` line. Delete this Environment afterwards.

## 8. The four kinds in one Project: a `mysql`, a Worker, a `web-private` and Cron services

**This walk costs about $0.10**: an hour or less of the network's load
balancer, a `db.t4g.micro` RDS for MySQL instance, three small Fargate tasks
running and the Cron runs' few minutes of one more. **RDS adds about 15
minutes** to it: the `mysql`'s create takes 10–15 minutes, and its Delete with
a final snapshot several more. **A `mysql` forgotten at the end costs about
$15 a month**, on top of the $36 a month a forgotten Environment network costs
(the top of this page); the final snapshot it leaves costs a few cents a month
until you delete it, which this step ends by doing.

This is the AWS twin of the Server walk, and the acceptance of the
spec for the four kinds. Steps
5f–5h try the Worker, the `web-private` and the Cron service one at a time;
this step puts all four of the spec's kinds in one Project, wired to each
other, and is the only proof of a `mysql` on RDS reached from a `web`. It is
required once before the first release that makes these kinds on AWS, and
**again whenever their generated resources, the OpenTofu or AWS provider pins
or the permission list change** (the three triggers of
[When it is required](#when-it-is-required)).

Do it in a new Environment of its own, its **Deploy target** this Cloud account
and `$REGION`, after step 1 with a stack made from the current template. Below,
`$ENV` is this Environment's id. You need two images of your own, pushed where
the platform host can pull them:

- **the `web-private` image** answers HTTP on 4000 with a line naming its host,
  and has a `HEALTHCHECK`, with a start period, that fetches that page;
- **the `web` image** serves on 8080 and, every 20 seconds, writes a row to
  MySQL through `DATABASE_URL` and fetches `INSIDE_URL`, printing
  `mysql rows: <n>` and `inside reply: …` to its Runtime log. It connects to
  MySQL with TLS on and the CA not verified, since the `url` carries no TLS
  parameter (`docs/linking-a-database.md`).

```yaml
version: 1

services:
  db:
    kind: mysql
    size: small
    database: walk
    user: walk_user_16char

  inside:
    kind: web-private
    port: 4000
    source: { image: <the web-private image> }

  web:
    kind: web
    size: small
    port: 8080
    source: { image: <the web image> }
    env: [{ DATABASE_URL: db.url }, INSIDE_URL]

  ticker:
    kind: worker
    source: { image: busybox:1.36 }
    command: sh
    args: ["-c", "while true; do echo tick; sleep 5; done"]

  nightly:
    kind: cron
    source: { image: busybox:1.36 }
    command: sh
    args: ["-c", "wget -qO- http://inside.cloudgate.internal:4000/ && echo nightly ran"]
    schedule: "0 3 * * *"

  stuck:
    kind: cron
    source: { image: busybox:1.36 }
    command: sleep
    args: ["120"]
    schedule: "0 3 * * *"
    timeout: 1m
```

`walk_user_16char` is 16 characters, RDS for MySQL's master-user limit:
the plan takes
it, and RDS must accept it. A `web-private` has no Output yet, so on the `web`
set `INSIDE_URL=http://inside.cloudgate.internal:4000` by hand.

1. **Check for changes.** The network step lists the private DNS namespace
   `cloudgate.internal` with the network. `db` is its own Cloud run, its size
   beside a `db.t4g` class, MySQL 8.4. `inside` lists a discovery service and
   no target group, listener rule or Domain; `ticker` no load balancer pieces;
   `nightly` and `stuck` a task definition and no ECS service; and `web` its
   two variables, `DATABASE_URL` wired, named and never shown.
2. **Apply.** The network's run goes first, then `db`'s, 10–15 minutes, which
   `web`'s waits for. No Cron run starts.
3. **Check for changes** again.

**Passes when** every Deployment ends done and the second **Check for
changes** finds nothing, no AWS line and no **Drift**: no task definition
carries a permanent diff from an image's `HEALTHCHECK` or its start period.
What was
registered and made says the same:

```bash
aws ecs describe-task-definition --region $REGION --task-definition cloudgate-<inside id> \
  --query 'taskDefinition.containerDefinitions[0].healthCheck'   # the image's: its command, interval, timeout, retries, startPeriod
aws ecs describe-task-definition --region $REGION --task-definition cloudgate-<nightly id> \
  --query 'taskDefinition.containerDefinitions[0].healthCheck'   # null: a run is judged by its exit code
aws ecs describe-task-definition --region $REGION --task-definition cloudgate-<web id> \
  --query 'taskDefinition.containerDefinitions[0].healthCheck'   # the web image's HEALTHCHECK, null when it has none
aws rds describe-db-instances --region $REGION \
  --query "DBInstances[?TagList[?Key=='cloudgate:environment' && Value=='$ENV']].[Engine,EngineVersion,MasterUsername,PubliclyAccessible,StorageEncrypted,DeletionProtection]"
# one row: mysql, 8.4.x, walk_user_16char, False, True, True
```

Then, in this order:

**The `web` passes when** its **Logs** tab shows `mysql rows: <n>` counting up
from 1 and `inside reply: …` carrying the `web-private`'s line, with no
`mysql error` or `inside error` line.

**The Worker passes when** `ticker`'s **Logs** tab shows a `tick` line every
five seconds, as in 5f.

**The Cron services pass when** Run now on `nightly` gives a green run whose
log shows the `web-private`'s line and then `nightly ran`, ending
`exit code 0`; and Run now on `stuck` gives a red run ending
`timed out after 1m`, its task stopped by Cloudgate:

```bash
aws ecs list-tasks --region $REGION --cluster cloudgate-$ENV --desired-status STOPPED
aws ecs describe-tasks --region $REGION --cluster cloudgate-$ENV --tasks <stuck's task arn> \
  --query 'tasks[0].stoppedReason'                                   # Stopped by Cloudgate
aws ecs list-services --region $REGION --cluster cloudgate-$ENV      # web, inside, ticker; no nightly-… or stuck-…
```

**The `web-private`'s Delete passes when**, after removing `inside` from the
config and applying (the `web`'s `inside error` lines that follow are
expected), its Cloud Map service is gone and the namespace stays:

```bash
aws servicediscovery list-namespaces --region $REGION \
  --query "Namespaces[?Name=='cloudgate.internal'].[Id,Properties.DnsProperties.HostedZoneId]"   # note both
aws servicediscovery list-services --region $REGION \
  --filters Name=NAMESPACE_ID,Values=<namespace id>                  # no inside
aws route53 list-hosted-zones-by-vpc --vpc-id <vpc id> --vpc-region $REGION   # cloudgate.internal. still
```

**The deploy role passes when it cannot delete a hosted zone that is not
its own**: its
`PrivateDnsHostedZone` statement grants only `route53:CreateHostedZone`, and
only through Cloud Map (`aws:ViaAWSService`). With your own credentials, make
an empty private hosted zone in a VPC outside the Environment network (the
default VPC will do); then, as the deploy role, through the Cloudgate user's
key from step 1, try to delete it and to make one directly:

```bash
aws route53 create-hosted-zone --name walk-unrelated.internal \
  --caller-reference walk-$(date +%s) --vpc VPCRegion=$REGION,VPCId=<another vpc id>   # as yourself; note its id
AWS_ACCESS_KEY_ID=<cloudgate key id> AWS_SECRET_ACCESS_KEY=<cloudgate secret> \
  aws sts assume-role --role-arn <DeployRoleArn> --external-id <ExternalId> \
  --role-session-name walk                                           # export the three credentials it prints
aws route53 delete-hosted-zone --id <its id>                         # as the role: AccessDenied
aws route53 create-hosted-zone --name walk-direct.internal \
  --caller-reference walk-$(date +%s) --vpc VPCRegion=$REGION,VPCId=<another vpc id>   # as the role: AccessDenied
```

Both are refused, and the zone is still there for you to delete as yourself.
A deleted zone is a failure of the walk.

**The Environment's Delete passes when** it goes as in step 6, with `db`
kept: the Delete asks whether to keep its data, the walk keeps it, and the run
names the final snapshot `<project>-<environment>-db-final-<date>`. Run step
6's databases checks and its tag, network-interface, by-name and IAM checks
for this `$ENV` and VPC; those for the `api`, `docs`, `uploads`, `pg-1` and
`redis` find nothing to name, and nothing else may be listed. The namespace and
its hosted zone are gone too:

```bash
aws servicediscovery list-namespaces --region $REGION \
  --query "Namespaces[?Name=='cloudgate.internal']"                  # none of this network's
aws route53 list-hosted-zones \
  --query "HostedZones[?Id=='/hostedzone/<hosted zone id>']"        # []
aws rds describe-db-snapshots --region $REGION --snapshot-type manual \
  --query "DBSnapshots[].DBSnapshotIdentifier"                       # …-db-final-<date>
```

The final snapshot is the one thing left on purpose. Once it is recorded,
delete it by hand:

```bash
aws rds delete-db-snapshot --region $REGION \
  --db-snapshot-identifier <project>-<environment>-db-final-<date>
```

## The record

Post this as a comment on the release:

```text
AWS walk by hand — <release> (<commit>)
Who / when: <name>, <date>
Account / region: <sandbox account alias>, <region>
OpenTofu / AWS provider: <from install.sh>   Policy version: <n>
Why: first release | version change | generated-resource change | permission change

1. Connect with the minimum role ............ pass/fail
2. Deploy the sample web .................... pass/fail
3. Domain over HTTPS ........................ pass/fail   (time to Live: <m> min)
4. Runtime log from the running task ........ pass/fail
5. Hand change in the next plan ............. pass/fail
5b. web reads and writes pg-1 and redis ..... pass/fail   (create took: pg-1 <m> min, redis <m> min)
5c. Existing database, no instance made ..... pass/fail
5d. static site on its Domain via CloudFront  pass/fail   (time to Live: <m> min)
    invalidation time ....................... <deploy 1: s>, <deploy 2: s>   (Deployed after: <s>, <s>)
    in-flight invalidation quotas ........... paths <n>, wildcard paths <n>
    distribution changes that replace ....... <none, or which>   (root object, spa, Domain add/remove)
5e. web writes and reads its bucket ......... pass/fail   (key variables unset: yes/no)
    existing bucket found, missing one refused  pass/fail
6. Delete leaves nothing billable ........... pass/fail   (checks run at <time>)
   … and only the two named final snapshots . pass/fail
   … and the bucket holding a file, named ... pass/fail
7. The same config on a Server .............. pass/fail
   … web writes to its Garage bucket ........ pass/fail
   … presigned URL through its Domain ....... pass/fail
8. The four kinds in one Project ............ pass/fail   (db create took: <m> min)
   … second plan finds nothing (HEALTHCHECK)  pass/fail
   … web writes to mysql, reaches inside .... pass/fail   (16-character user accepted: yes/no)
   … Worker's tick lines .................... pass/fail
   … nightly green, reached inside .......... pass/fail
   … stuck timed out after 1m, stopped ...... pass/fail
   … inside's Delete clears its Cloud Map service  pass/fail
   … deploy role cannot delete another zone . pass/fail
   … Delete leaves only the db final snapshot pass/fail   (namespace and hosted zone gone: yes/no)
   … final snapshot deleted by hand ......... pass/fail

Findings: <none, or a ticket each>
```
