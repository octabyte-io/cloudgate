import type { SimulationContextEntry } from './aws/setup-template';

/**
 * The cloud port: the one seam through which Cloudgate reaches AWS (the AWS spec,
 * "The cloud port"). Everything that calls an AWS API — and spawns
 * `tofu` — goes through {@link AwsCloudPort}, whose only implementation is
 * `AwsCloudAdapter`, the one file that imports the AWS SDK. Every e2e spec
 * gets an in-memory fake in its place (`test/utils/fake-cloud-port.ts`, as
 * `ctx.cloud`), mirroring slice 1's config reader port.
 *
 * **Primitive calls, not the checks built from them.** The connect check's
 * sequence lives in `aws/connect-check.ts` over these calls, so the fake only
 * scripts what AWS would answer, never what Cloudgate concludes from it.
 *
 * **Answers, not exceptions.** A call AWS refuses resolves to
 * `{ ok: false, code, message }` with AWS's own error code and words, which a
 * check passes on to the operator. An exception means the call never got an
 * answer (no network), and the caller fails rather than concludes.
 *
 * Later tickets grow this interface — tofu, tags and existence,
 * ECS, logs, ACM and DNS, ECR, RDS Stop and Start
 * a cloud database's backups, CloudFront, and RDS and
 * ElastiCache for a cloud database's Delete, and a Cron service's
 * one-off tasks and their log streams, and a hosted cloud build in
 * CodeBuild — by adding methods here and to the fake.
 */
export const AWS_CLOUD_PORT = Symbol('AWS_CLOUD_PORT');

/** An AWS credential: an IAM user's key, or a role session's temporary one. */
export interface AwsCredential {
  accessKeyId: string;
  secretAccessKey: string;
  /** Present on a role session only. */
  sessionToken?: string;
}

/** {@link AwsCloudPort.ecsStanding}'s answer: what is still there, of what was asked. */
export interface EcsStanding {
  /** Running or pending tasks, ACTIVE services, clusters and task definitions, and any other ECS ARN. */
  readonly live: readonly string[];
  /** Task definitions deregistered but not deleted: nothing bills, but they keep their tags. */
  readonly inactiveTaskDefinitions: readonly string[];
}

/** {@link AwsCloudPort.ec2Standing}'s answer: what is still there, of what was asked. */
export interface Ec2Standing {
  /** VPCs, subnets, security groups, route tables and internet gateways EC2 describes, and any other EC2 ARN. */
  readonly live: readonly string[];
}

/** What AWS answered: the value, or its refusal in its own words. */
export type AwsAnswer<T> =
  { ok: true; value: T } | { ok: false; code: string; message: string };

export interface AssumeRoleRequest {
  roleArn: string;
  /** `null` asks without one — the connect check's negative test. */
  externalId: string | null;
  sessionName: string;
}

export interface CallerIdentity {
  account: string;
  arn: string;
}

export interface SimulatePolicyRequest {
  /** The role whose policies are simulated — never an assumed-role ARN. */
  policySourceArn: string;
  actions: string[];
  resourceArn: string;
  context: SimulationContextEntry[];
}

export interface SimulatedDecision {
  action: string;
  resourceArn: string;
  /** AWS's `EvalDecision`. */
  decision: 'allowed' | 'explicitDeny' | 'implicitDeny';
}

/** The network creates the region check dry-runs, as EC2 names them. */
export type Ec2NetworkAction =
  | 'CreateVpc'
  | 'CreateSubnet'
  | 'CreateInternetGateway'
  | 'CreateRouteTable'
  | 'CreateSecurityGroup';

export interface Ec2DryRunRequest {
  region: string;
  action: Ec2NetworkAction;
  /** The tags the create carries, so a tag-on-create condition is met. */
  tags: Record<string, string>;
  /**
   * The VPC a subnet, route table or security group is made in. The check has
   * none yet, so it names a stand-in; AWS answers whether the role may.
   */
  vpcId: string;
}

/**
 * A Google Cloud account's credential as a Cloud run hands it to the Google
 * provider (the Google Cloud spec): the contents of a credential configuration file — an
 * external account's, which trades the run's own signed token at STS and
 * steps into the deploy service account (S16), made by the Google port's
 * `credentialConfiguration`. Never a service account's key. The shared runner writes it into the run's own
 * `0700` working folder for `GOOGLE_APPLICATION_CREDENTIALS`, and removes it
 * with the folder.
 */
export interface GoogleCredential {
  credentialConfiguration: string;
}

/** What a Cloud run signs in with: an AWS key, or a Google credential (the Google Cloud spec). */
export type TofuCredential = AwsCredential | GoogleCredential;

/**
 * One `tofu` run against one Infrastructure state. The definition is
 * written as the working folder's `main.tf.json`; everything secret — the
 * state login, the state key, `variables` and an AWS key — reaches `tofu`
 * through its environment only. A Google credential is the one exception: a
 * file in the run's own folder, as the Google provider reads one (the Google Cloud spec).
 *
 * The AWS port takes an AWS key; the shared runner (`tofu/tofu-runner.ts`)
 * takes either cloud's.
 */
export interface TofuRunRequest<
  Credential extends TofuCredential = AwsCredential,
> {
  /** The state's id, which is its OpenTofu workspace in the `pg` backend. */
  stateId: string;
  /** The Cloud account's own key; the definition's provider takes on the deploy role with it. */
  credential: Credential;
  /** The OpenTofu definition (JSON syntax), from `aws/definitions/`. */
  definition: Record<string, unknown>;
  /** Values for the definition's `variable` blocks, passed as `TF_VAR_<name>`. */
  variables?: Record<string, string>;
  /**
   * Resource addresses the plan is limited to (`-target`), with what they
   * depend on. Only a cloud Service's first deploy uses it, to make its ECR
   * repository before the image is pushed into it.
   */
  targets?: string[];
  /**
   * Resource addresses the plan makes anew (`-replace`) though nothing in
   * the definition asks it to. Only an approved "replace VM" line of a
   * Stack VM uses it (#1368), so a Stack VM is never made again unseen.
   */
  replaces?: string[];
  /** Each line `tofu` prints, as it prints it. */
  onLine?: (line: string) => void;
  /**
   * Ends the run from outside (Stop the run, the time limit, shutdown): its
   * interrupt sends `tofu` one interrupt, its kill kills `tofu` and its
   * provider. The Cloud run pool's `CloudRunSignal` is one.
   */
  signal?: TofuRunSignal;
}

/**
 * How a running `tofu` hears it must end, in two steps — the shape of the
 * Cloud run pool's `CloudRunSignal`, which sends the kill 5 minutes
 * after the interrupt. A listener added after its step fired runs at once.
 */
export interface TofuRunSignal {
  readonly interrupted: boolean;
  readonly killed: boolean;
  onInterrupt(listener: () => void): void;
  onKill(listener: () => void): void;
}

/** Why a run did not finish, each with the sentence the operator reads. */
export type TofuFailureReason =
  /** The installed OpenTofu or a run's provider is not this checkout's pin. Nothing ran. */
  | 'install-mismatch'
  /** The state was last written by a newer OpenTofu or provider: "upgrade Cloudgate". Nothing ran. */
  | 'newer-state'
  /** OpenTofu's advisory lock on the state is held: "another run is using this state". */
  | 'lock-held'
  /**
   * OpenTofu's `pg` backend could not take the one key it shares across every
   * state, held while another state's workspace is made. Nothing ran
   * on this state; the run can simply be made again.
   */
  | 'state-backend-busy'
  /** The state could not be decrypted or read; it is never written over. */
  | 'unreadable-state'
  /** Ended from outside, by an interrupt and, if needed, a kill. */
  | 'interrupted'
  /** `tofu` itself failed: AWS refused something, a definition error. */
  | 'failed';

export interface TofuFailure {
  ok: false;
  reason: TofuFailureReason;
  message: string;
  /**
   * The step that failed when it was `tofu plan` or `tofu apply`, the two
   * that ask the cloud to make the definition: absent when the run ended
   * before its plan (the install check, `init`, the workspace, recording
   * what it would forget) or on its own `beforeApply`.
   */
  failedAt?: 'plan' | 'apply';
}

/**
 * The failures of a run that changed nothing: each ends it before `tofu`
 * touched the state or the cloud, so a Delete or a removal that meets one
 * removed nothing, and fails as such.
 */
export const CHANGED_NOTHING: ReadonlySet<TofuFailureReason> = new Set([
  'install-mismatch',
  'newer-state',
  'lock-held',
  'state-backend-busy',
  'unreadable-state',
]);

/**
 * One resource an AWS Infrastructure state holds, as an operator may see it
 * (ADR-0036 item 3): never a setting's value. `aws/state-resources.ts`
 * makes these from the state; nothing else of a state leaves the runner.
 */
export interface StateResource {
  /** The OpenTofu resource type, e.g. `aws_ecs_service`. */
  type: string;
  /** Its id in AWS: a `vpc-…`, an ARN, a role's name. */
  awsId: string;
  /** Its region, or `global` for IAM. */
  region: string;
  /** Its tags in AWS, Cloudgate's four among them (values are ids). */
  tags: Record<string, string>;
  /**
   * Whether a tag search finds it: false for IAM and for what carries no
   * tag of Cloudgate's. Recovery by tag cannot adopt it.
   */
  findableByTag: boolean;
}

/**
 * One resource a Google Infrastructure state holds, as an operator may see
 * it (as {@link StateResource} on AWS): never a setting's value.
 * `gcp/state-resources.ts` makes these from the state.
 */
export interface GoogleStateResource {
  /** The OpenTofu resource type, e.g. `google_cloud_run_v2_service`. */
  type: string;
  /** The fixed name Cloudgate gave it, or Google's id for a kind with no name. */
  googleName: string;
  /** Its region, or `global`. */
  region: string;
  /** Its labels in Google Cloud, Cloudgate's three among them (values are ids' keys). */
  labels: Record<string, string>;
  /**
   * Whether it carries Cloudgate's state label: false for the kinds that
   * take no labels — networks, subnets — which are not
   * findable by mark and are checked by their fixed name instead.
   */
  labelled: boolean;
}

/**
 * A read of what a state holds: `tofu init` and `tofu show -json` of
 * the state, with a definition that is only the backend and the provider.
 * It takes no lock and changes nothing.
 */
export interface TofuStateReadRequest<
  Credential extends TofuCredential = AwsCredential,
> {
  stateId: string;
  credential: Credential;
  /** `destroyDefinition`'s frame: the `pg` backend and the provider. */
  definition: Record<string, unknown>;
  /** The region a resource without its own is in. */
  region: string;
}

export type TofuStateOutcome<Resource = StateResource> =
  { ok: true; resources: Resource[] } | TofuFailure;

/** `tofu show -json` of the run's saved plan, without its `variables`. */
export type TofuShow = Record<string, unknown>;

export type TofuPlanOutcome = { ok: true; show: TofuShow } | TofuFailure;

export type TofuApplyOutcome =
  | {
      ok: true;
      /** The plan that was applied. */
      show: TofuShow;
      /** `tofu output -json`, each output's value. */
      outputs: Record<string, unknown>;
    }
  | TofuFailure;

export interface TofuApplyRequest<
  Credential extends TofuCredential = AwsCredential,
> extends TofuRunRequest<Credential> {
  /**
   * Called with the fresh plan before anything changes; returning a failure
   * (a plan that is not the one the operator approved) stops the run there.
   */
  beforeApply?: (show: TofuShow) => TofuFailure | null;
  /**
   * Instances of one `for_each` block taken out of the state before the
   * plan, so the run never destroys them: a Domain's certificate
   * that ACM refuses to delete for 20–40 minutes after CloudFront drops it.
   */
  forget?: ForgetRequest;
}

/** Which instances an apply takes out of its state first. */
export interface ForgetRequest {
  /** The block, e.g. `aws_acm_certificate.domain`. */
  resource: string;
  /** The keys the definition still has; every other instance is forgotten. */
  keep: readonly string[];
  /**
   * Told of the instances before the state lets go of them, so each is
   * recorded for deleting; a throw stops the run before anything changes.
   */
  before: (found: ForgottenInstance[]) => Promise<void>;
}

/** One instance a run took out of its state, as the state held it. */
export interface ForgottenInstance {
  /** Its address, e.g. `aws_acm_certificate.domain["d1-1"]`. */
  address: string;
  arn: string;
  /** Its own `region` (AWS provider 6), else `null`: the state's. */
  region: string | null;
  /** A certificate's `domain_name`, else `null`. */
  domainName: string | null;
}

/** What ACM answered a `DeleteCertificate`. */
export type AcmDeletion = 'deleted' | 'in-use' | 'gone';

/**
 * One `docker login` to a Cloud account's ECR registry in a region:
 * `ecr:GetAuthorizationToken`'s answer, decoded. Asked fresh for each
 * Deployment, used once, and never stored or logged.
 */
export interface EcrLogin {
  /** The registry host, e.g. `123456789012.dkr.ecr.eu-central-1.amazonaws.com`. */
  registry: string;
  /** Always `AWS`. */
  username: string;
  /** The 12-hour token: a secret. */
  password: string;
}

export interface EcrCleanUpRequest {
  region: string;
  repositoryName: string;
  /** The live image's tag; every image but the one it names is deleted. */
  keepTag: string;
}

export interface EcsServiceRef {
  region: string;
  /** The cluster's ARN (or name). */
  cluster: string;
  /** The ECS service's name. */
  service: string;
}

/** A task of the rollout that stopped, as ECS describes it. */
export interface StoppedTask {
  /** The task's id: the last part of its ARN, and of its log stream's name. */
  taskId: string;
  /** ECS's own words: `stoppedReason`, with the container's exit when it has one. */
  stoppedReason: string;
}

/**
 * Where an ECS service's newest deployment is: its `rolloutState`, and
 * the latest of its tasks that stopped, if one did. A deploy waits for
 * `completed` ("steady") and ends `error` on a stopped task.
 */
export interface EcsRollout {
  state: 'in-progress' | 'completed' | 'failed';
  /** ECS's `rolloutStateReason`, when it gives one. */
  reason: string | null;
  stoppedTask: StoppedTask | null;
}

export interface LogEventsRequest {
  region: string;
  logGroupName: string;
  logStreamNames: string[];
  /** At most this many of the newest events. */
  limit: number;
}

export interface LogEvent {
  timestamp: number;
  message: string;
}

/**
 * The Runtime log's read: every stream under a prefix of the
 * Service's log group, from `startTime` on, oldest first.
 */
export interface LogStreamsRequest {
  region: string;
  logGroupName: string;
  logStreamNamePrefix: string;
  /** Epoch milliseconds, inclusive. */
  startTime: number;
  /** At most this many events, the oldest first. */
  limit: number;
}

/** One event of {@link LogStreamsRequest}'s read, with the stream it came from. */
export interface StreamLogEvent {
  /** CloudWatch's own id, the same however often the event is read. */
  eventId: string;
  logStreamName: string;
  timestamp: number;
  message: string;
}

export interface LogStreamsPage {
  events: StreamLogEvent[];
  /** Whether events after the last one were left for a later read. */
  more: boolean;
}

/** ACM's `Status` of a certificate. */
export type AcmStatus =
  | 'PENDING_VALIDATION'
  | 'ISSUED'
  | 'INACTIVE'
  | 'EXPIRED'
  | 'VALIDATION_TIMED_OUT'
  | 'REVOKED'
  | 'FAILED';

/** One ACM certificate as `acm:DescribeCertificate` answers it. */
export interface AcmCertificate {
  status: AcmStatus;
  /** ACM's `FailureReason`, when it gives one. */
  reason?: string | null;
  /** The DNS validation record ACM asks for, once it has named it. */
  validationRecord?: { name: string; type: string; value: string } | null;
}

/**
 * What a name answers in DNS, looked up from the platform host: its
 * CNAME targets and its addresses. Never an AWS call, but the cloud port's
 * all the same, so the e2e suite scripts DNS as it scripts AWS.
 */
export interface DnsAnswer {
  cnames: string[];
  addresses: string[];
}

/** A tag search in one region: every resource carrying all of `tags`. */
export interface TagSearchRequest {
  region: string;
  tags: Record<string, string>;
}

/** A resource a tag search found, by its ARN, with the tags it carries. */
export interface TaggedResource {
  arn: string;
  tags: Record<string, string>;
}

/** A network card in a region that one of these security groups is on. */
export interface NetworkInterfacesRequest {
  region: string;
  securityGroupIds: string[];
}

export interface NetworkInterface {
  networkInterfaceId: string;
  /** Which of the asked security groups it is on. */
  securityGroupIds: string[];
  /** AWS's own description, e.g. `arn:aws:ecs:…:attachment/…`. */
  description: string;
}

/**
 * One snapshot of a cloud database as AWS lists it: an automatic one
 * AWS takes in its backup window and deletes after the retention, or a kept
 * (manual) one — a final snapshot among them — that stays until someone
 * deletes it.
 */
export interface DatabaseSnapshot {
  /** RDS's `DBSnapshotIdentifier`, ElastiCache's `SnapshotName`. */
  id: string;
  type: 'automated' | 'manual';
  /** When it was taken (ISO 8601), or `null` while AWS has not said. */
  createdAt: string | null;
  /** AWS's own status word: `available`, `creating`, … */
  status: string;
  /**
   * Its size in AWS's own words: RDS gives the instance's allocated storage
   * (`20 GB`), ElastiCache the node's cache size (`5 MB`). `null` when AWS
   * gives none.
   */
  size: string | null;
}

/**
 * What RDS holds of an instance's backups, read live for its Backups
 * tab and never by a plan: its retention, the window point-in-time restore
 * reaches, and its snapshots.
 */
export interface RdsBackups {
  /** `DescribeDBInstances`' `BackupRetentionPeriod`, in days. */
  retentionDays: number;
  /** `DescribeDBInstanceAutomatedBackups`' `RestoreWindow.EarliestTime`. */
  earliestRestorableTime: string | null;
  /** `DescribeDBInstances`' `LatestRestorableTime`. */
  latestRestorableTime: string | null;
  /** `DescribeDBSnapshots`, automated and manual, newest first. */
  snapshots: DatabaseSnapshot[];
}

/** What ElastiCache holds of a replication group's backups. */
export interface CacheBackups {
  /** `DescribeReplicationGroups`' `SnapshotRetentionLimit`; 0 is off. */
  retentionDays: number;
  /** `DescribeSnapshots` of the group, newest first. */
  snapshots: DatabaseSnapshot[];
}

/** A cloud database by its name in AWS, in its region. */
export interface CloudDatabaseRef {
  region: string;
  /** The RDS instance identifier, or the ElastiCache replication group id. */
  identifier: string;
}

/** One RDS instance in a region, by its identifier. */
export interface RdsInstanceRef {
  region: string;
  /** `rdsInstanceIdentifier(postgresId)`: `cloudgate-…`. */
  identifier: string;
}

/**
 * What RDS answered a Stop or Start with: the instance's
 * `DBInstanceStatus` as the call left it, `stopping` or `starting`.
 */
export interface RdsInstanceState {
  status: string;
}

/**
 * A `static` site's origin switch (the AWS buckets spec "Landing" 3): the
 * distribution's one origin pointed at a Deployment's folder. Never through
 * `tofu`, so it reopens no plan; the definition ignores the origin.
 */
export interface OriginSwitchRequest {
  distributionId: string;
  /** The origin's id in the distribution (`STATIC_ORIGIN_ID`). */
  originId: string;
  /** The folder, as CloudFront takes it: a leading `/`, no trailing one. */
  originPath: string;
}

/** CloudFront's `Status` of a distribution: `Deployed` once a change has spread. */
export type DistributionStatus = 'InProgress' | 'Deployed';

/** CloudFront's `Status` of an invalidation. */
export type InvalidationStatus = 'InProgress' | 'Completed';

export interface InvalidationRequest {
  distributionId: string;
  /** The paths cleared, e.g. `['/*']`. */
  paths: string[];
  /**
   * CloudFront's `CallerReference`: the Deployment's id, so a call made
   * twice for one Deployment makes one invalidation.
   */
  callerReference: string;
}

/**
 * What lifting an instance's deletion protection answered: `lifted`
 * once RDS took the change (or protection was already off), `no-instance`
 * when there is no such instance — nothing to protect, so nothing to lift.
 */
export type DeletionProtectionLift = 'lifted' | 'no-instance';

/** A Stack VM's data-disk snapshot as its Delete reads it (#1367). */
export interface VolumeSnapshot {
  readonly snapshotId: string;
  readonly state: 'pending' | 'completed' | 'error';
  /** The size of the volume it was taken from, which it is billed up to. */
  readonly sizeGb: number;
}

/** A Stack VM's final snapshot to take of its data disk (#1367). */
export interface VolumeSnapshotRequest {
  readonly region: string;
  readonly volumeId: string;
  /** Its `Name` tag: `<project>-<environment>-<stack>-final-<date>`. */
  readonly name: string;
  readonly description: string;
  readonly tags: Readonly<Record<string, string>>;
}

/** A database's final snapshot in a region, by its name. */
export interface SnapshotRef {
  region: string;
  name: string;
}

/**
 * A final snapshot as AWS describes it: its ARN and how much it
 * holds — RDS's allocated storage in GB, ElastiCache's cache size in GiB —
 * which is what it is billed by.
 */
export interface FinalSnapshot {
  arn: string;
  sizeGb: number;
}

/**
 * One Cron service run on ECS (ADR-0034 as amended): a
 * one-off Fargate task of the Cron service's task definition, on its
 * Environment network's cluster, in its public subnets with a public IP and
 * the Cron service's own security group. No ECS service holds it.
 */
export interface EcsRunTaskRequest {
  region: string;
  /** The Environment network's cluster ARN. */
  cluster: string;
  /** The revision the last successful build wrote, by its full ARN. */
  taskDefinitionArn: string;
  subnets: readonly string[];
  securityGroups: readonly string[];
  /**
   * ECS's `startedBy` (at most 128 characters): the run's job name, so the
   * task says which Run record it is.
   */
  startedBy: string;
  /**
   * The task's tags: Cloudgate's mark, so `StopTask`, which the deploy role
   * may call only on what carries its Cloud account's tag, can stop it.
   */
  tags: Record<string, string>;
}

/** What `RunTask` answered: the task it started, or ECS's reason for none. */
export type EcsRunTaskOutcome =
  { started: true; taskArn: string } | { started: false; reason: string };

/** Tasks of one cluster, by ARN. */
export interface EcsTasksRef {
  region: string;
  cluster: string;
  taskArns: readonly string[];
}

export interface EcsStopTaskRequest {
  region: string;
  cluster: string;
  taskArn: string;
  /** ECS's `reason`, which it shows as the task's `stoppedReason`. */
  reason: string;
}

/** One task as `ecs:DescribeTasks` describes it. */
export interface EcsTaskState {
  taskArn: string;
  /** ECS's `lastStatus`: `PROVISIONING`, `PENDING`, `RUNNING`, …, `STOPPED`. */
  lastStatus: string;
  /** Its container's exit code, once it has one. */
  exitCode: number | null;
  /** ECS's `stoppedReason`, with its container's own reason, once stopped. */
  stoppedReason: string | null;
}

/** One log stream, read on from where an earlier read ended. */
export interface LogStreamReadRequest {
  region: string;
  logGroupName: string;
  logStreamName: string;
  /** Where the last read ended (its `next`), or `null` from the start. */
  from: string | null;
}

/** What one read of a log stream found, and where the next read starts. */
export interface LogStreamRead {
  messages: string[];
  /** Where to read on from; `from` again when nothing was new. */
  next: string | null;
}

/**
 * One hosted cloud build in CodeBuild (ADR-0047): a build of the
 * Environment network's standing project (`cloud-build-names.ts`), from the
 * source zip the platform host uploaded, with the buildspec Cloudgate wrote
 * for this Deployment. `codebuild:StartBuild` on the project, which the
 * deploy role may call only on a project carrying its Cloud account's tag.
 */
export interface CodeBuildStartRequest {
  region: string;
  projectName: string;
  /** The zip, as CodeBuild names an S3 source: `<bucket>/<key>`. */
  sourceLocation: string;
  /** The whole buildspec (YAML), in place of the project's own. */
  buildspec: string;
  /**
   * CodeBuild's `idempotencyToken`: the Deployment's id, so a start asked
   * twice for one Deployment starts one build.
   */
  idempotencyToken: string;
  /**
   * The build's environment variables, each read from an SSM parameter by
   * CodeBuild as the build identity (`PARAMETER_STORE`): a private
   * registry's password for the build that copies a ready-made image.
   * Only a parameter's name is ever sent, so no variable carries a
   * value `BatchGetBuilds` and the CodeBuild console show in plain text;
   * there is deliberately no way to send a `PLAINTEXT` one.
   */
  parameterVariables?: readonly CodeBuildParameterVariable[];
}

/** One build variable CodeBuild reads from a parameter. */
export interface CodeBuildParameterVariable {
  /** The variable's name inside the build. */
  name: string;
  /** The SSM parameter's name, e.g. `/cloudgate/build/<tag>/<id>/registry-password`. */
  parameterName: string;
}

/**
 * A SecureString parameter one hosted cloud build reads, made by
 * the deploy role (`ssm:PutParameter` on `parameter/cloudgate/*`) with its
 * Cloud account's tag, never overwriting one that exists.
 */
export interface BuildParameterPut {
  region: string;
  name: string;
  value: string;
  /** The Cloud account's id, as its tag. */
  tagValue: string;
}

/** One parameter, by name, in a region. */
export interface ParameterRef {
  region: string;
  name: string;
}

/**
 * A Session Manager session to one Stack VM's SSH port (ADR-0070): the
 * instance, and its region.
 */
export interface SshSessionRequest {
  region: string;
  instanceId: string;
}

/**
 * What `ssm:StartSession` answers: the session, and the stream and token
 * the Session Manager plugin carries its bytes over. The token is a
 * credential for that one session, never logged.
 */
export interface SshSession {
  sessionId: string;
  streamUrl: string;
  tokenValue: string;
}

/** A Stack VM's EC2 instance, in its region (ADR-0070). */
export interface Ec2InstanceRef {
  region: string;
  instanceId: string;
}

/**
 * EC2's `InstanceState.Name`: what a Stop or Start left the instance in,
 * or what it is now.
 */
export type Ec2InstanceState =
  | 'pending'
  | 'running'
  | 'shutting-down'
  | 'terminated'
  | 'stopping'
  | 'stopped';

/** The Session Manager document that runs SSH inside a session. */
export const SSH_SESSION_DOCUMENT = 'AWS-StartSSHSession';

/** A build of a project in a region, by CodeBuild's id (`<project>:<uuid>`). */
export interface CodeBuildRef {
  region: string;
  buildId: string;
}

/**
 * Where a CodeBuild build is, as `codebuild:BatchGetBuilds` answers it.
 * `queued` is CodeBuild's `SUBMITTED` and `QUEUED` phases, the wait for
 * capacity that a fresh account's one-build-at-a-time quota makes long and
 * that never counts against the Cloud run time limit; `running` is every
 * phase from `PROVISIONING` to `FINALIZING`; `ended` is `COMPLETED`.
 */
export interface CodeBuildState {
  phase: 'queued' | 'running' | 'ended';
  /** CodeBuild's `buildStatus`; `IN_PROGRESS` until it has ended. */
  status:
    'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT' | 'STOPPED';
  /** CodeBuild's words for the phase that failed, when it gives them. */
  reason: string | null;
  /** Its CloudWatch log stream in the project's log group, once named. */
  logStreamName: string | null;
  /** The buildspec's `exported-variables`, as the build left them. */
  exportedVariables: Record<string, string>;
}

export interface AwsCloudPort {
  /** `sts:GetCallerIdentity` — needs no permission, so it proves only that the credential is real. */
  callerIdentity(credential: AwsCredential): Promise<AwsAnswer<CallerIdentity>>;
  /** `sts:AssumeRole` with the given credential. */
  assumeRole(
    credential: AwsCredential,
    request: AssumeRoleRequest,
  ): Promise<AwsAnswer<AwsCredential>>;
  /** `iam:SimulatePrincipalPolicy`, every page of it; creates nothing. */
  simulatePrincipalPolicy(
    credential: AwsCredential,
    request: SimulatePolicyRequest,
  ): Promise<AwsAnswer<SimulatedDecision[]>>;
  /**
   * One EC2 create with `DryRun`, which creates nothing. AWS always answers a
   * dry run with an error: `DryRunOperation` when the call would have been
   * allowed, which this answers `ok: true`, and its refusal otherwise
   * (`UnauthorizedOperation`, `OptInRequired`, …). Unlike the simulation, a
   * dry run meets what the simulator cannot see — an SCP, a region the
   * account has not enabled.
   */
  ec2DryRun(
    credential: AwsCredential,
    request: Ec2DryRunRequest,
  ): Promise<AwsAnswer<true>>;
  /** `ec2:DescribeVpcs` in the region, every page: how many VPCs it holds. */
  countVpcs(
    credential: AwsCredential,
    region: string,
  ): Promise<AwsAnswer<number>>;

  /** `tofu` init and plan against the state; changes nothing. */
  plan(request: TofuRunRequest): Promise<TofuPlanOutcome>;
  /** `tofu` init, plan, and apply of that plan, streaming its lines. */
  apply(request: TofuApplyRequest): Promise<TofuApplyOutcome>;
  /** `tofu` init, a destroy plan, and apply of it, streaming its lines. */
  destroy(request: TofuApplyRequest): Promise<TofuApplyOutcome>;
  /**
   * What the state holds, each resource's type, AWS id, region and tags
   * only. A state with no workspace yet holds nothing.
   */
  stateResources(request: TofuStateReadRequest): Promise<TofuStateOutcome>;

  /**
   * `ecr:GetAuthorizationToken` in the region with a deploy-role session.
   * The password is a secret: it goes to `docker login` through an
   * environment variable only.
   */
  ecrAuthorizationToken(
    session: AwsCredential,
    region: string,
  ): Promise<AwsAnswer<EcrLogin>>;
  /**
   * Deletes every image of the repository but the one `keepTag` names
   * (`ecr:ListImages`, `ecr:BatchDeleteImage`), once a deploy is steady.
   */
  ecrDeleteImagesExcept(
    session: AwsCredential,
    request: EcrCleanUpRequest,
  ): Promise<AwsAnswer<{ deleted: number }>>;
  /** `ecs:UpdateService` with only `desiredCount`: the Service's `replicas`. */
  ecsSetDesiredCount(
    session: AwsCredential,
    request: EcsServiceRef & { desiredCount: number },
  ): Promise<AwsAnswer<true>>;
  /**
   * `ecs:UpdateService` with `forceNewDeployment`: every running copy is
   * replaced by a fresh one of the same task definition (Reload).
   */
  ecsForceNewDeployment(
    session: AwsCredential,
    request: EcsServiceRef,
  ): Promise<AwsAnswer<true>>;
  /**
   * `rds:StopDBInstance`: a stop AWS undoes by itself after seven
   * days. RDS refuses one not `available` (`InvalidDBInstanceState`).
   */
  rdsStopInstance(
    session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<RdsInstanceState>>;
  /** `rds:StartDBInstance` of a stopped instance. */
  rdsStartInstance(
    session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<RdsInstanceState>>;
  /** `ecs:DescribeServices` (and, after a failed task, `DescribeTasks`). */
  ecsRollout(
    session: AwsCredential,
    request: EcsServiceRef,
  ): Promise<AwsAnswer<EcsRollout>>;
  /** CloudWatch `FilterLogEvents`: the newest `limit` events, oldest first. */
  filterLogEvents(
    session: AwsCredential,
    request: LogEventsRequest,
  ): Promise<AwsAnswer<LogEvent[]>>;
  /**
   * CloudWatch `FilterLogEvents` over every stream under a prefix, from a
   * time on: the Runtime log's poll. Never Live Tail.
   */
  filterLogStreams(
    session: AwsCredential,
    request: LogStreamsRequest,
  ): Promise<AwsAnswer<LogStreamsPage>>;

  /** `acm:DescribeCertificate`: a Domain's certificate, polled. */
  acmDescribeCertificate(
    session: AwsCredential,
    request: { region: string; certificateArn: string },
  ): Promise<AwsAnswer<AcmCertificate>>;
  /**
   * `acm:DeleteCertificate` of a certificate no Domain names: ACM's
   * `ResourceInUseException` is `in-use`, its `ResourceNotFoundException`
   * `gone`; anything else a refusal.
   */
  acmDeleteCertificate(
    session: AwsCredential,
    request: { region: string; certificateArn: string },
  ): Promise<AwsAnswer<AcmDeletion>>;
  /**
   * A DNS lookup from the platform host: only ever informs a tick on
   * a Domain's records, never blocks anything. A name that answers nothing
   * answers empty lists.
   */
  dnsLookup(name: string): Promise<DnsAnswer>;

  /**
   * Resource Groups Tagging `GetResources`, every page: what carries the
   * tags in the region. Every plan's read searches by Cloudgate's tags
   * (ADR-0036 item 6), to adopt what a state lost and name what no
   * state wants. It cannot see IAM roles or the network cards AWS makes.
   */
  findTagged(
    session: AwsCredential,
    request: TagSearchRequest,
  ): Promise<AwsAnswer<TaggedResource[]>>;
  /**
   * What ECS says of resources a tag search found: the tag index
   * keeps a stopped task, a deleted service or cluster and an INACTIVE task
   * definition for minutes or for good, though none of them is there to
   * bill. `ecs:DescribeTasks`, `DescribeServices`, `DescribeClusters` and
   * `DescribeTaskDefinition`; one ECS does not know is gone.
   */
  ecsStanding(
    session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<EcsStanding>>;
  /**
   * What EC2 says of resources a tag search found: the tag index
   * keeps a deleted subnet or VPC for minutes after a destroy. Asked by id
   * with `ec2:DescribeVpcs`, `DescribeSubnets`, `DescribeSecurityGroups`,
   * `DescribeRouteTables` and `DescribeInternetGateways`, the types
   * Cloudgate's definitions make; one EC2 answers `Invalid…ID.NotFound` for
   * is gone, and an EC2 ARN of any other type is live, unconfirmed.
   */
  ec2Standing(
    session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<Ec2Standing>>;
  /** `ecs:DeleteTaskDefinitions` of INACTIVE revisions, so none stays behind. */
  ecsDeleteTaskDefinitions(
    session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<true>>;
  /**
   * `ecs:RunTask` of one Cron service run: the task it started, or
   * the reason ECS gave in its `failures` for starting none.
   */
  ecsRunTask(
    session: AwsCredential,
    request: EcsRunTaskRequest,
  ): Promise<AwsAnswer<EcsRunTaskOutcome>>;
  /**
   * `ecs:DescribeTasks` by ARN: each task ECS still describes. ECS
   * keeps a stopped task for about an hour, so one it has forgotten is
   * simply not in the answer.
   */
  ecsDescribeTasks(
    session: AwsCredential,
    request: EcsTasksRef,
  ): Promise<AwsAnswer<EcsTaskState[]>>;
  /**
   * `ecs:StopTask`: a stop ECS took, or a task it no longer knows,
   * which is gone all the same.
   */
  ecsStopTask(
    session: AwsCredential,
    request: EcsStopTaskRequest,
  ): Promise<AwsAnswer<true>>;
  /**
   * CloudWatch `GetLogEvents` of one stream, oldest first, from where the
   * last read ended: a Cron run's own stream, copied into its
   * Deployment log while it runs. A stream not made yet reads as empty.
   */
  readLogStream(
    session: AwsCredential,
    request: LogStreamReadRequest,
  ): Promise<AwsAnswer<LogStreamRead>>;
  /** `iam:GetRole`: the role's ARN, or `null` when there is no such role. */
  findIamRole(
    session: AwsCredential,
    roleName: string,
  ): Promise<AwsAnswer<{ arn: string } | null>>;
  /**
   * `ec2:DescribeNetworkInterfaces` filtered by security group, every page:
   * the cards AWS made for tasks (no tag of Cloudgate's is on them) that
   * still hold one of the groups.
   */
  networkInterfacesOf(
    session: AwsCredential,
    request: NetworkInterfacesRequest,
  ): Promise<AwsAnswer<NetworkInterface[]>>;

  /**
   * The backups RDS holds of an instance: `rds:DescribeDBInstances`,
   * `DescribeDBInstanceAutomatedBackups` and every page of
   * `DescribeDBSnapshots`. A read for the Backups tab only; no plan uses it.
   * An instance RDS does not have is its refusal, `DBInstanceNotFoundFault`.
   */
  rdsBackups(
    session: AwsCredential,
    request: CloudDatabaseRef,
  ): Promise<AwsAnswer<RdsBackups>>;
  /**
   * The backups ElastiCache holds of a replication group:
   * `elasticache:DescribeReplicationGroups` and every page of
   * `DescribeSnapshots`. A read for the Backups tab only. A group it does not
   * have is its refusal, `ReplicationGroupNotFoundFault`.
   */
  cacheBackups(
    session: AwsCredential,
    request: CloudDatabaseRef,
  ): Promise<AwsAnswer<CacheBackups>>;
  /**
   * CloudFront `GetDistributionConfig`, then `UpdateDistribution` with its
   * ETag changing only the named origin's `OriginPath`. Answers once
   * CloudFront has taken the change, not once it has spread.
   */
  cloudFrontSwitchOrigin(
    session: AwsCredential,
    request: OriginSwitchRequest,
  ): Promise<AwsAnswer<true>>;
  /** CloudFront `CreateInvalidation`: the new invalidation's id. */
  cloudFrontCreateInvalidation(
    session: AwsCredential,
    request: InvalidationRequest,
  ): Promise<AwsAnswer<{ invalidationId: string }>>;
  /** CloudFront `GetDistribution`: whether its last change has spread. */
  cloudFrontDistributionStatus(
    session: AwsCredential,
    distributionId: string,
  ): Promise<AwsAnswer<DistributionStatus>>;
  /** CloudFront `GetInvalidation`: whether the cache clear has completed. */
  cloudFrontInvalidationStatus(
    session: AwsCredential,
    request: { distributionId: string; invalidationId: string },
  ): Promise<AwsAnswer<InvalidationStatus>>;

  // ── The database side of the direct calls: a Delete of a cloud
  // database needs what `tofu destroy` cannot do from the state alone.

  /**
   * `rds:ModifyDBInstance` with `DeletionProtection: false`, applied at
   * once: the first step of a postgres on RDS's Delete, since RDS refuses
   * to delete a protected instance. `rds:DescribeDBInstances` first, so a
   * gone instance answers `no-instance` and one already unprotected is not
   * changed again.
   */
  rdsLiftDeletionProtection(
    session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<DeletionProtectionLift>>;
  /** `rds:DescribeDBSnapshots` by identifier: the snapshot, or `null` when there is none. */
  rdsSnapshot(
    session: AwsCredential,
    request: SnapshotRef,
  ): Promise<AwsAnswer<FinalSnapshot | null>>;
  /** `elasticache:DescribeSnapshots` by name: the snapshot, or `null` when there is none. */
  elastiCacheSnapshot(
    session: AwsCredential,
    request: SnapshotRef,
  ): Promise<AwsAnswer<FinalSnapshot | null>>;

  // ── A Stack VM's Delete (#1367): its data disk's final snapshot and
  // the daily snapshots Data Lifecycle Manager took, neither in a state.

  /**
   * `ec2:CreateSnapshot` of a Stack VM's data disk, tagged with its name
   * and Cloudgate's tags: answers once EBS has started it, `null` when EC2
   * has no such volume.
   */
  ec2TakeSnapshot(
    session: AwsCredential,
    request: VolumeSnapshotRequest,
  ): Promise<AwsAnswer<VolumeSnapshot | null>>;
  /** `ec2:DescribeSnapshots` of one snapshot, or `null` when there is none. */
  ec2Snapshot(
    session: AwsCredential,
    request: { readonly region: string; readonly snapshotId: string },
  ): Promise<AwsAnswer<VolumeSnapshot | null>>;
  /** The ids of the account's snapshots of a volume that Data Lifecycle Manager took. */
  ec2DailySnapshots(
    session: AwsCredential,
    request: { readonly region: string; readonly volumeId: string },
  ): Promise<AwsAnswer<string[]>>;
  /** `ec2:DeleteSnapshot`; one already gone answers `true` too. */
  ec2DeleteSnapshot(
    session: AwsCredential,
    request: { readonly region: string; readonly snapshotId: string },
  ): Promise<AwsAnswer<true>>;

  // ── A hosted cloud build (ADR-0047): direct calls, never `tofu`
  // (ADR-0030); OpenTofu makes only the project, bucket and log group.

  /** `codebuild:StartBuild` with a source and buildspec override: the build's id. */
  codeBuildStart(
    session: AwsCredential,
    request: CodeBuildStartRequest,
  ): Promise<AwsAnswer<{ buildId: string }>>;
  /** `codebuild:BatchGetBuilds` of one build. One CodeBuild does not know is its refusal. */
  codeBuildState(
    session: AwsCredential,
    request: CodeBuildRef,
  ): Promise<AwsAnswer<CodeBuildState>>;
  /** `codebuild:StopBuild`; one already ended answers `true` all the same. */
  codeBuildStop(
    session: AwsCredential,
    request: CodeBuildRef,
  ): Promise<AwsAnswer<true>>;
  /** `ssm:PutParameter` of a new SecureString a build reads. */
  putBuildParameter(
    session: AwsCredential,
    request: BuildParameterPut,
  ): Promise<AwsAnswer<true>>;
  /** `ssm:DeleteParameter`; one already gone answers `true` all the same. */
  deleteParameter(
    session: AwsCredential,
    request: ParameterRef,
  ): Promise<AwsAnswer<true>>;
  /**
   * `ssm:StartSession` to a Stack VM with {@link SSH_SESSION_DOCUMENT} on
   * port 22: the session a Stack VM's tunnel carries SSH over.
   */
  startSshSession(
    session: AwsCredential,
    request: SshSessionRequest,
  ): Promise<AwsAnswer<SshSession>>;
  /** `ssm:TerminateSession`; one already ended answers `true` all the same. */
  terminateSession(
    session: AwsCredential,
    request: { region: string; sessionId: string },
  ): Promise<AwsAnswer<true>>;
  /**
   * `ec2:StopInstances` of a Stack VM: its disks stay, and only they are
   * billed while it is stopped. Answers the state the call left it in.
   */
  ec2StopInstance(
    session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>>;
  /** `ec2:StartInstances` of a stopped Stack VM; answers the state the call left it in. */
  ec2StartInstance(
    session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>>;
  /**
   * `ec2:DescribeInstances` of one Stack VM: its state now. An instance EC2
   * does not know is its refusal, `InvalidInstanceID.NotFound`.
   */
  ec2InstanceState(
    session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>>;
}
