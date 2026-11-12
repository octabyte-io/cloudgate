# Running a Cron service

A **Cron service** runs a command on a timetable: a nightly report, a cleanup, a sync. You describe one in the Project config as `kind: cron`. Each firing is a **run**: a fresh container from the Cron service's last successful build, which exits when the command does. On a Server a run is a one-off Swarm job; in an AWS Cloud account, a one-off ECS task (see [On AWS](#on-aws)).

---

## Describing one

```yaml
version: 1
services:
  nightly-report:
    kind: cron
    source:
      github: acme/shop
      path: /report
    command: node dist/report.js
    schedule: "0 3 * * *"
    timezone: Europe/Berlin
    timeout: 30m
```

`command` and `schedule` are required. `schedule` is a five-field unix cron expression, read in `timezone` (default `UTC`). On the night the clocks go forward, a time that does not exist that day is skipped. On the night they go back, a time that happens twice fires once.

## How the timetable fires

Cloudgate's backend keeps the timetable of every Cron service on a Server. At each fire time it starts a run, as Run now does. The run's Run record, and the first line of its log, say it was started by **the timetable**.

- **Runs may overlap.** A run still going at the next fire time does not stop the next one: both run, side by side. If two copies of your command must not run at once, make the command check for that itself, for example with a lock it takes in your database.
- **A run is never retried.** A run that fails, or whose job could not be started, is recorded as failed and nothing starts it again. The next run is the next fire time.
- **A fire time missed while Cloudgate was down is not made up.** When Cloudgate starts again, the timetable fires from that moment on. The fire times in between leave no Run record at all. If a run must not be skipped, make the command catch up on what it missed when it next runs.
- **While Cloudgate is up, a fire time is fired late rather than dropped.** The timetable looks every 10 seconds; if one look comes late, for example because a Server it was waiting on was slow, it still starts a run for each fire time it crossed. If one Cron service crossed more than 10 fire times in a single look, only the first 10 start a run, and the backend's log says so.
- **Nothing fires before the first build.** A Cron service whose Build deployment has never succeeded is waiting for its first build: there is no image to run, so its fire times pass with no run and no failed Run record.

A change to `schedule` or `timezone`, applied by a plan, takes effect from the next fire time on the new timetable. Destroying the Cron service stops its timetable.

## How long a run may take

Every run is held to the Cron service's `timeout`: `1h` unless you set one, and at most `24h`. It applies to every run, whether the timetable or Run now started it, and counts from the moment the run started.

- **A run that reaches its `timeout` is stopped.** Cloudgate's backend removes its Swarm job, keeps the output the run made until then in its log, and records the run as failed. The log's last line is `timed out after <timeout>`, for example `timed out after 30m`, in place of an exit code. Cloudgate checks every 10 seconds, so a run can go on a few seconds past its limit.
- **A run is recorded as over only once its job is gone.** If its Server cannot be reached when the run reaches its `timeout`, or when you stop the Cron service, the run stays recorded as running, and Cloudgate tries again every 10 seconds until it can remove the job. A cancel that cannot reach the Server is refused and says so, and the run goes on; cancel again later.
- **A run going while Cloudgate restarts is picked up again.** When the backend starts, it looks at every run still recorded as running. If the run's job is still on its Server, Cloudgate watches it again, and its time limit still counts from when it first started, not from the restart: a run already past its limit is stopped at once. If the job ended while Cloudgate was down, the run is recorded from its exit code.
- **A run whose job is gone with no exit code is recorded as lost.** It counts as failed, and the last line of its log starts with `lost:`. Nothing starts it again.

## Which code a run runs

A run starts from the image of the Cron service's **last successful build**, resolved when the run starts. A build that finishes while a run is going does not change that run.

Each build that succeeds pins its image for the runs: a tag of its own, `<appName>:build-<id>`, on the Server that built it, or the registry's digest when the image is pushed to a registry or pulled from one. So a later build that fails after its image was made, or an image source's tag moving upstream, never changes what a run starts from. If the pin cannot be made, the build's log says so and runs start from the Service's image name.

A Cron service is built on its own, like any other Service. So **right after a push, a Cron service can run older code than a `web` built from the same repository**: until the Cron service's own build succeeds, its runs use the build before it. If a run must match the `web`'s code, for example after a database migration, wait for the Cron service's Build deployment to succeed, or press Run now once it has.

## On AWS

In an Environment whose Deploy target is an AWS Cloud account, a Cron service is a **task definition with no ECS service**. Its plan lists its ECR repository, task definition (with its `command` and `args`), task role, an SSM parameter per variable, log group and a security group with no inbound rule. There is no ECS service and no EventBridge schedule, so nothing bills between runs but its stored images and logs.

- **Cloudgate's own timetable fires the runs, as on a Server.** `schedule`, `timezone`, daylight saving, missed fire times, overlap and no retries all behave exactly as above. **A run happens only while Cloudgate is up**: a fire time that falls while Cloudgate is down leaves no run, on AWS as on a Server.
- **A run is one ECS task** (`RunTask`), on the Environment network's cluster, Fargate, in its public subnets with a public IP and the Cron service's own security group, so it can reach the Environment's databases, its Private web services and the internet. It is a task of the task definition revision the last successful deploy registered; a run in flight keeps the revision it started on.
- **Its Run record and log are the same as on a Server.** The log's first line names the image and what started the run; while the task runs, its own CloudWatch stream is copied into the log, and once it has stopped the stream is read on, as on Google Cloud below, since CloudWatch can show a last line a few seconds late; the last line is its exit code, `timed out after <timeout>`, or the reason ECS gave for not starting it. A task ECS cannot start, or a Cloud account Cloudgate cannot reach, fails the run with the reason.
- **`timeout` stops the task** (`StopTask`) and records the run as failed. **A `timeout` that falls due while Cloudgate is down is enforced late**: when Cloudgate starts again it stops every task already past its limit. A task still running is watched again; one that ended while Cloudgate was down is recorded from its exit code; one ECS no longer describes (it keeps a stopped task about an hour) is recorded as `result unknown: Cloudgate was down when it finished`.
- **Actions.** Run now starts one task (`deployment: create`), even while paused. Cancel stops that run's task (`deployment: cancel`). Stop pauses the timetable and stops each run in flight; Start resumes it. Deploy builds, pushes and registers a new task definition revision, and starts no run. Delete stops each run in flight, then removes the Cron service's AWS resources. There is no Reload and no Remove containers.
- **What a plan shows.** A changed `command`, `args` or `size` is an AWS line on the task definition. A changed `schedule`, `timezone` or `timeout` is a Cloudgate setting: the plan shows it with no AWS line, and Apply changes it without calling AWS. Nothing of the timetable is in AWS, so nothing of it can drift.
- **The image's `HEALTHCHECK` is never used**: a run is judged by its exit code alone.

Its Cloud account's role needs `ecs:RunTask` (policy version 2). A role set up from an older template is named as out of date on the Cloud account's page until it is updated.

## On Google Cloud

In an Environment whose Deploy target is a Google Cloud account, a Cron service is **one Cloud Run job**. Its plan lists its Artifact Registry repository, service account, a Secret Manager secret per variable, and the job, with its `command` and `args`. The job runs one task, with no parallelism and no retries, and leaves through Direct VPC egress on the Environment network's subnet, so a run reaches the Environment's databases and Private web services. There is no Cloud Scheduler and no always-on Cloud Run service, so nothing bills between runs but its stored images and logs.

- **Cloudgate's own timetable fires the runs, as on a Server and AWS.** `schedule`, `timezone`, daylight saving, missed fire times, overlap and no retries all behave exactly as above. **A run happens only while Cloudgate is up**: a fire time that falls while Cloudgate is down leaves no run, on Google Cloud as everywhere.
- **A run is one execution of the job** (`jobs.run`). Its Run record keeps the execution's name. Each fire time is its own execution, so a run still going at the next fire time does not stop the next one. An execution runs the image the job had when it started; a deploy while it runs does not change it.
- **Its Run record and log are the same as on a Server.** The log's first line names the image and what started the run. While the execution runs, its own output is copied from Cloud Logging, by its execution's name, so two runs at once never mix. The last line is its container's exit code, or Google's reason when there is none (an image it could not pull, for example), or `timed out after <timeout>`. An execution Google cannot start, or a Cloud account Cloudgate cannot reach, fails the run with the reason. Cloud Logging can take a few seconds to show a line, so once the execution ends Cloudgate goes on reading its output every 3 seconds, until a read made 10 seconds or more after the end finds nothing new, and for 30 seconds at most, before it writes the exit code line. The run is recorded as succeeded or failed as soon as it ends; a run that printed nothing has its exit code line about 12 seconds later.
- **`timeout` cancels the execution** (`executions.cancel`) and records the run as failed. The job's own task timeout is fixed at 24 hours, only as a backstop for a run Cloudgate lost track of. **A `timeout` that falls due while Cloudgate is down is enforced late**: when Cloudgate starts again it cancels every execution already past its limit. One still running is watched again; one that ended while Cloudgate was down is recorded from its exit code; one Google no longer has is recorded as `result unknown: Cloudgate was down when it finished`.
- **Actions.** Run now starts one execution (`deployment: create`), even while paused. Cancel cancels that run's execution (`deployment: cancel`). Stop pauses the timetable and cancels each run in flight; Start resumes it. Deploy builds, pushes and updates the job's image, and starts no run. Delete cancels each run in flight, then removes the Cron service's Google Cloud resources; the check after it looks for a leftover job too. There is no Reload and no Remove containers.
- **What a plan shows.** A changed `command`, `args` or `size` is a Google line on the job. A changed `schedule`, `timezone` or `timeout` is a Cloudgate setting: the plan shows it with no Google line, and Apply changes it without calling Google. Nothing of the timetable is in Google Cloud, so nothing of it can drift.
- **No health check**: a run is judged by how its execution ends alone.

Its Cloud account's deploy role needs the Cloud Run job, execution and task permissions of role version 4. A role set up from an older script is named as out of date on the Cloud account's page until it is updated.
