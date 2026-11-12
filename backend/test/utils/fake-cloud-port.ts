import type {
  AcmCertificate,
  AcmDeletion,
  ForgottenInstance,
  AssumeRoleRequest,
  AwsAnswer,
  AwsCloudPort,
  AwsCredential,
  CacheBackups,
  CallerIdentity,
  CloudDatabaseRef,
  DistributionStatus,
  DeletionProtectionLift,
  EcsStanding,
  Ec2Standing,
  FinalSnapshot,
  DnsAnswer,
  Ec2DryRunRequest,
  Ec2NetworkAction,
  EcrCleanUpRequest,
  EcrLogin,
  EcsRollout,
  EcsRunTaskOutcome,
  EcsRunTaskRequest,
  EcsServiceRef,
  EcsStopTaskRequest,
  EcsTaskState,
  EcsTasksRef,
  LogStreamRead,
  LogStreamReadRequest,
  InvalidationRequest,
  InvalidationStatus,
  LogEvent,
  LogEventsRequest,
  LogStreamsPage,
  LogStreamsRequest,
  StreamLogEvent,
  NetworkInterface,
  NetworkInterfacesRequest,
  RdsBackups,
  RdsInstanceRef,
  RdsInstanceState,
  OriginSwitchRequest,
  SimulatedDecision,
  SnapshotRef,
  VolumeSnapshot,
  VolumeSnapshotRequest,
  SimulatePolicyRequest,
  TaggedResource,
  TagSearchRequest,
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuFailure,
  TofuPlanOutcome,
  TofuRunRequest,
  TofuRunSignal,
  TofuShow,
  TofuStateOutcome,
  TofuStateReadRequest,
  CodeBuildRef,
  CodeBuildStartRequest,
  CodeBuildState,
  BuildParameterPut,
  ParameterRef,
  SshSession,
  SshSessionRequest,
  Ec2InstanceRef,
  Ec2InstanceState,
} from '../../src/cloud-accounts/cloud.port';
import { readFileSync } from 'node:fs';
import { renderDefinition } from '../../src/cloud-accounts/definitions/tofu-json';
import { stateResources } from '../../src/cloud-accounts/aws/state-resources';
import type { TofuStateShow } from '../../src/cloud-accounts/tofu/state-show';
import { join } from 'node:path';

/** One call the fake answered, without any secret in it. */
export type FakeCloudCall =
  | { method: 'callerIdentity'; accessKeyId: string; session: boolean }
  | {
      method: 'assumeRole';
      accessKeyId: string;
      roleArn: string;
      externalId: string | null;
    }
  | {
      method: 'simulatePrincipalPolicy';
      policySourceArn: string;
      actions: string[];
      resourceArn: string;
      context: SimulatePolicyRequest['context'];
    }
  | {
      method: 'ec2DryRun';
      region: string;
      action: Ec2NetworkAction;
      tags: Record<string, string>;
    }
  | { method: 'countVpcs'; region: string }
  | {
      method: 'plan' | 'apply' | 'destroy';
      stateId: string;
      accessKeyId: string;
      /** The names of the variables passed, never their values. */
      variables: string[];
      /** The `-target` addresses, when the run was limited to some. */
      targets?: string[];
      /** A Service definition's task CPU (`runtime_platform`), when it has one. */
      cpuArchitecture?: string;
      /** A Service definition's Domain certificates by key, when it has them. */
      domainCertificates?: string[];
      /** Which of those go on the listener. */
      attachedCertificates?: string[];
      /** A static site's distribution's alternate domain names. */
      distributionAliases?: string[];
      /** The instances taken out of the state before the plan. */
      forgotten?: string[];
    }
  | { method: 'ecrAuthorizationToken'; region: string; session: boolean }
  | {
      method: 'ecrDeleteImagesExcept';
      region: string;
      repositoryName: string;
      keepTag: string;
    }
  | {
      method: 'ecsSetDesiredCount';
      region: string;
      cluster: string;
      service: string;
      desiredCount: number;
    }
  | {
      method: 'ecsForceNewDeployment';
      region: string;
      cluster: string;
      service: string;
    }
  | { method: 'ecsRollout'; region: string; cluster: string; service: string }
  | { method: 'rdsStopInstance'; region: string; identifier: string }
  | { method: 'rdsStartInstance'; region: string; identifier: string }
  | {
      method: 'filterLogEvents';
      region: string;
      logGroupName: string;
      logStreamNames: string[];
      limit: number;
    }
  | {
      method: 'filterLogStreams';
      region: string;
      logGroupName: string;
      logStreamNamePrefix: string;
      startTime: number;
      limit: number;
      session: boolean;
    }
  | { method: 'acmDescribeCertificate'; region: string; certificateArn: string }
  | { method: 'acmDeleteCertificate'; region: string; certificateArn: string }
  | { method: 'dnsLookup'; name: string }
  | { method: 'findTagged'; region: string; tags: Record<string, string> }
  | { method: 'stateResources'; stateId: string; region: string }
  | { method: 'findIamRole'; roleName: string }
  | {
      method: 'ecsStanding' | 'ecsDeleteTaskDefinitions' | 'ec2Standing';
      region: string;
      arns: readonly string[];
    }
  | {
      method: 'networkInterfacesOf';
      region: string;
      securityGroupIds: string[];
    }
  | {
      method: 'rdsBackups' | 'cacheBackups';
      region: string;
      identifier: string;
      session: boolean;
    }
  | ({ method: 'cloudFrontSwitchOrigin' } & OriginSwitchRequest)
  | ({ method: 'cloudFrontCreateInvalidation' } & InvalidationRequest)
  | { method: 'cloudFrontDistributionStatus'; distributionId: string }
  | {
      method: 'cloudFrontInvalidationStatus';
      distributionId: string;
      invalidationId: string;
    }
  | {
      method: 'rdsLiftDeletionProtection';
      region: string;
      identifier: string;
    }
  | {
      method: 'rdsSnapshot' | 'elastiCacheSnapshot';
      region: string;
      name: string;
    }
  // A Stack VM's Delete (#1367): its final snapshot, and DLM's.
  | ({ method: 'ec2TakeSnapshot' } & VolumeSnapshotRequest)
  | { method: 'ec2Snapshot'; region: string; snapshotId: string }
  | { method: 'ec2DailySnapshots'; region: string; volumeId: string }
  | { method: 'ec2DeleteSnapshot'; region: string; snapshotId: string }
  | ({ method: 'ecsRunTask' } & EcsRunTaskRequest)
  | {
      method: 'ecsDescribeTasks';
      region: string;
      cluster: string;
      taskArns: readonly string[];
    }
  | ({ method: 'ecsStopTask' } & EcsStopTaskRequest)
  | ({ method: 'readLogStream' } & LogStreamReadRequest)
  | ({ method: 'codeBuildStart' } & CodeBuildStartRequest)
  | ({ method: 'codeBuildState' | 'codeBuildStop' } & CodeBuildRef)
  // Its value only in `parameters`: a call carries no secret.
  | ({ method: 'putBuildParameter' } & Omit<BuildParameterPut, 'value'>)
  | ({ method: 'deleteParameter' } & ParameterRef)
  | ({ method: 'startSshSession' } & SshSessionRequest)
  | { method: 'terminateSession'; region: string; sessionId: string }
  | ({
      method: 'ec2StopInstance' | 'ec2StartInstance' | 'ec2InstanceState';
    } & Ec2InstanceRef);

/**
 * How the fake's next CodeBuild build goes. By default it runs at
 * once, writes no lines and succeeds, exporting an amd64 image with no
 * `HEALTHCHECK`.
 */
export interface FakeBuildScript {
  /** How long, in real milliseconds, it waits in CodeBuild's queue. */
  queuedMs?: number;
  /** What it writes to its log, one line per state read while it runs. */
  lines?: string[];
  /** It keeps running, its lines written, until {@link FakeCloudPort.endBuild}. */
  held?: boolean;
  /** How it ends by itself. */
  status?: 'SUCCEEDED' | 'FAILED' | 'FAULT' | 'TIMED_OUT';
  /** CodeBuild's words for the phase that failed. */
  reason?: string;
  /** What `docker image inspect` said inside it, as it exports it. */
  image?: string;
  /** StartBuild's refusal, in AWS's words; no build is started. */
  refusal?: { code: string; message: string };
}

/** A build the fake's CodeBuild started. */
export interface FakeBuild {
  readonly buildId: string;
  readonly request: CodeBuildStartRequest;
  readonly script: FakeBuildScript;
  readonly startedAt: number;
  /** How many of its lines it has written. */
  written: number;
  /** How it ended, once it has. */
  ended: CodeBuildState['status'] | null;
  /** Whether StopBuild was asked for it. */
  stopAsked: boolean;
}

/** A task the fake's ECS started for a Cron service run. */
export interface FakeEcsTask {
  readonly taskArn: string;
  readonly region: string;
  readonly cluster: string;
  readonly taskDefinitionArn: string;
  readonly startedBy: string;
  readonly tags: Record<string, string>;
  lastStatus: string;
  exitCode: number | null;
  stoppedReason: string | null;
}

/**
 * The Cloud run pool's two-step signal (`CloudRunSignal`), driven by
 * hand: `interrupt()`, then `kill()`. A listener added after its step fired
 * runs at once, as the pool's does.
 */
export class TestRunSignal implements TofuRunSignal {
  interrupted = false;
  killed = false;
  private readonly onInterrupts: (() => void)[] = [];
  private readonly onKills: (() => void)[] = [];

  onInterrupt(listener: () => void): void {
    if (this.interrupted) listener();
    else this.onInterrupts.push(listener);
  }

  onKill(listener: () => void): void {
    if (this.killed) listener();
    else this.onKills.push(listener);
  }

  interrupt(): void {
    this.interrupted = true;
    for (const listener of this.onInterrupts.splice(0)) listener();
  }

  kill(): void {
    this.killed = true;
    for (const listener of this.onKills.splice(0)) listener();
  }
}

/** A stored real `tofu show -json` (spec seam 2), by its name in `test/cloud-accounts/fixtures/plans/`. */
export function storedPlan(name: string): TofuShow {
  return JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        'cloud-accounts',
        'fixtures',
        'plans',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as TofuShow;
}

/** A stored `tofu show -json` of a state, by its name in `test/cloud-accounts/fixtures/states/`. */
function storedState(name: string): TofuStateShow {
  return JSON.parse(
    readFileSync(
      join(
        __dirname,
        '..',
        'cloud-accounts',
        'fixtures',
        'states',
        `${name}.json`,
      ),
      'utf8',
    ),
  ) as TofuStateShow;
}

/** What `tofu show -json` prints for a plan with nothing to do. */
const EMPTY_PLAN: TofuShow = {
  format_version: '1.2',
  terraform_version: '1.13.1',
  resource_changes: [],
};

/**
 * Which definition a run was given, read off its resources: an Environment
 * network's (its VPC) or a cloud `web` Service's (its ECS service). A plan
 * read of a new state has a fresh id a spec cannot know in advance,
 * so it scripts by kind instead.
 */
export type DefinitionKind =
  | 'network'
  | 'web'
  /** A Worker on ECS: an ECS service with no target group. */
  | 'worker'
  /**
   * A Private web service on ECS: an ECS service listed in private
   * DNS by its discovery service, with no target group.
   */
  | 'web-private'
  /** A Cron service on ECS: a task definition and no ECS service. */
  | 'cron'
  | 'postgres'
  /** A mysql on RDS: the RDS definition with `engine = "mysql"`. */
  | 'mysql'
  | 'bucket'
  | 'redis'
  | 'static'
  /** An Existing database's lookup: `data` sources only. */
  | 'existing-postgres'
  /** An existing bucket's lookup: `data` sources only. */
  | 'existing-bucket'
  /** An Existing cache's lookup: its replication group. */
  | 'existing-redis'
  /** Its second look, once AWS has no such group: a serverless cache. */
  | 'existing-redis-serverless'
  /** A Compose stack's Stack VM: its EC2 instance (ADR-0070). */
  | 'stack-vm';

function definitionKind(
  definition: Record<string, unknown>,
): DefinitionKind | null {
  const data = (definition.data ?? {}) as Record<string, unknown>;
  if ('aws_db_instances' in data) return 'existing-postgres';
  if ('aws_s3_buckets' in data) return 'existing-bucket';
  if ('aws_elasticache_replication_group' in data) return 'existing-redis';
  if ('aws_elasticache_serverless_cache' in data) {
    return 'existing-redis-serverless';
  }
  const resources = (definition.resource ?? {}) as Record<string, unknown>;
  if ('aws_vpc' in resources) return 'network';
  if ('aws_ecs_service' in resources) {
    if ('aws_service_discovery_service' in resources) return 'web-private';
    return 'aws_lb_target_group' in resources ? 'web' : 'worker';
  }
  // A Cron service: its task definition, and no ECS service.
  if ('aws_ecs_task_definition' in resources) return 'cron';
  if ('aws_db_instance' in resources) {
    const instances = resources.aws_db_instance as Record<
      string,
      { engine?: string }
    >;
    return Object.values(instances).some((one) => one.engine === 'mysql')
      ? 'mysql'
      : 'postgres';
  }
  // A static site holds its own bucket too: its distribution first.
  if ('aws_cloudfront_distribution' in resources) return 'static';
  if ('aws_s3_bucket' in resources) return 'bucket';
  if ('aws_elasticache_replication_group' in resources) return 'redis';
  if ('aws_instance' in resources) return 'stack-vm';
  return null;
}

/** One failure a spec scripts for the tofu half; `hang` ends only by interrupt. */
type ScriptedTofu =
  | { kind: 'lock-held' }
  | { kind: 'unreadable-state' }
  | { kind: 'install-mismatch'; message: string }
  | { kind: 'failed'; message: string }
  | { kind: 'hang' };

/** The session token the fake hands a role session, so it can tell one from a key. */
const SESSION_TOKEN = 'fake-session-token';

/**
 * The cloud port faked in memory (spec seam 2), one for every e2e spec:
 * `createTestApp` registers it in place of `AwsCloudAdapter` unless a suite
 * brings its own double, exposes it as `ctx.cloud`, and `resetDb` resets it.
 * No e2e reaches AWS.
 *
 * By default AWS says yes to everything, the way a role made from the setup
 * template would: any key signs in, any role is taken on with an external id
 * and refused without one, the session is in the account its role ARN names,
 * and every simulated action is allowed. A spec scripts the one refusal it is
 * about, in AWS's own error codes and words. Mirrors `fake-config-reader.ts`.
 */
export class FakeCloudPort implements AwsCloudPort {
  /** Every call, in order, for a spec asserting what reached AWS — and what did not. */
  readonly calls: FakeCloudCall[] = [];
  private keyRefusal: string | null = null;
  private roleRefusal: string | null = null;
  private withoutExternalId = false;
  private identityAccount: string | null = null;
  private readonly denied = new Set<string>();
  private simulateRefusal: string | null = null;
  private readonly dryRunRefusals = new Map<
    Ec2NetworkAction,
    { code: string; message: string }
  >();
  private vpcs = 1;
  /** Stored plans to replay, per state; `*` answers every state. */
  private readonly plans = new Map<string, TofuShow>();
  private readonly outputsByState = new Map<string, Record<string, unknown>>();
  /** Scripted failures, per state; `*` fails every state. */
  private readonly tofuFailures = new Map<string, ScriptedTofu>();
  /** Stored plans and scripted failures by definition kind, after a state's own. */
  private readonly plansByKind = new Map<DefinitionKind, TofuShow>();
  private readonly failuresByKind = new Map<DefinitionKind, ScriptedTofu>();
  /**
   * What each tofu run was handed, in order: its definition as `main.tf.json`
   * and its variables' values, for a spec asserting a value reached
   * `tofu` as a variable and nowhere in the definition.
   */
  readonly tofuInputs: {
    stateId: string;
    definition: string;
    variables: Record<string, string>;
  }[] = [];
  /** Every ECR password handed out, in order, for a spec to look for. */
  readonly ecrPasswords: string[] = [];
  /** A new task that stops instead of starting, and what it printed. */
  private failedStart: { stoppedReason: string; lines: string[] } | null = null;
  /** What the Services' log groups hold, by group, in the order written. */
  private readonly logGroups = new Map<string, StreamLogEvent[]>();
  private logsRefusal: { code: string; message: string } | null = null;
  /** RDS's refusal of the next Stop or Start, in its words. */
  private rdsRefusal: { code: string; message: string } | null = null;
  /** What ACM answers, per certificate ARN; `*` answers every one. */
  private readonly acm = new Map<string, AcmCertificate>();
  /** How many more deletes ACM refuses as in use, per certificate ARN. */
  private readonly acmInUse = new Map<string, number>();
  /** The certificates ACM has deleted. */
  readonly acmDeleted = new Set<string>();
  /** The Domain certificates each state holds, as its last apply left them. */
  private readonly certificatesHeld = new Map<string, ForgottenInstance[]>();
  /** What DNS answers, per name (lower case, no trailing dot). */
  private readonly dns = new Map<string, DnsAnswer>();
  /** What a Delete leaves: tagged resources, IAM roles, network cards, per region. */
  private leftTagged: (TaggedResource & { region: string })[] = [];
  /** ECS ARNs the tag index still lists that ECS calls stopped or deleted. */
  private ecsGone = new Set<string>();
  /** Task definitions the tag index lists that ECS calls INACTIVE. */
  private ecsInactive = new Set<string>();
  /** EC2 ARNs the tag index still lists that EC2 says are deleted. */
  private ec2Gone = new Set<string>();
  /** EC2's refusal of every `ec2Standing`, when a spec scripts one. */
  private ec2StandingRefusal: { code: string; message: string } | null = null;
  private readonly leftRoles = new Map<string, string>();
  private leftCards: (NetworkInterface & { region: string })[] = [];
  /** AWS cannot be reached at all: every call throws, as with no network. */
  private cutOff: string | null = null;
  /** What each state holds, as `tofu show -json` of it prints it. */
  private readonly states = new Map<string, TofuStateShow>();
  /** What RDS and ElastiCache hold of each database's backups, by identifier. */
  private readonly rdsHeld = new Map<string, RdsBackups>();
  private readonly cacheHeld = new Map<string, CacheBackups>();
  private backupsRefusal: { code: string; message: string } | null = null;
  /** Each distribution's origin path, as the last switch left it. */
  private readonly originPaths = new Map<string, string>();
  /** Each invalidation made, by its id. */
  readonly invalidations = new Map<
    string,
    { distributionId: string; paths: string[]; polls: number }
  >();
  /** How many status reads of a switched distribution answer `InProgress`. */
  private distributionPolls = 0;
  private distributionHeld = 0;
  /** How many status reads of an invalidation answer `InProgress`. */
  private invalidationHeld = 0;
  /** AWS's refusal of the next origin switch, if a spec scripted one. */
  private switchRefusal: { code: string; message: string } | null = null;
  /** AWS's refusal of the next cache clear, if a spec scripted one. */
  private invalidationRefusal: { code: string; message: string } | null = null;
  /**
   * The final snapshot each state's last applied definition asks for,
   * which its destroy then takes: RDS's or ElastiCache's, by name.
   */
  private readonly finalSnapshots = new Map<
    string,
    { service: 'rds' | 'elasticache'; name: string; sizeGb: number }
  >();
  /** The final snapshots destroys took, by service and name. */
  private readonly snapshots = new Map<string, FinalSnapshot>();
  /** A scripted refusal of lifting deletion protection, or the instance gone. */
  private protectionLift:
    { code: string; message: string } | DeletionProtectionLift | null = null;
  /** The tasks ECS started for Cron service runs, by ARN. */
  private readonly ecsTasks = new Map<string, FakeEcsTask>();
  /** How many task definition revisions each Cron service's state registered. */
  private readonly cronRevisions = new Map<string, number>();
  /** ECS's reason for starting no task, if a spec scripted one. */
  private runTaskRefusal: string | null = null;
  /** ECS's refusal of every `StopTask`, if a spec scripted one. */
  private stopTaskRefusal: { code: string; message: string } | null = null;
  /** The scripts of the next CodeBuild builds, in order. */
  private buildScripts: FakeBuildScript[] = [];
  /** Every build CodeBuild started, by id, in order. */
  private readonly codeBuilds = new Map<string, FakeBuild>();
  /** Each Stack VM's EC2 state, by instance id; one not named is `running`. */
  private readonly ec2States = new Map<string, Ec2InstanceState>();
  /** EC2's refusal of every Stack VM Stop, Start and read, if a spec scripted one. */
  private ec2InstanceRefusal: { code: string; message: string } | null = null;
  /** SSM's parameters the cloud port wrote, by region and name. */
  private readonly ssmParameters = new Map<
    string,
    { value: string; tagValue: string }
  >();

  callerIdentity(
    credential: AwsCredential,
  ): Promise<AwsAnswer<CallerIdentity>> {
    const session = credential.sessionToken === SESSION_TOKEN;
    this.calls.push({
      method: 'callerIdentity',
      accessKeyId: credential.accessKeyId,
      session,
    });
    if (!session && this.keyRefusal !== null) {
      return refused('InvalidClientTokenId', this.keyRefusal);
    }
    // A session's access key id is the role ARN it came from (see assumeRole).
    const account =
      this.identityAccount ??
      (session ? accountOf(credential.accessKeyId) : '000000000000');
    return Promise.resolve({
      ok: true,
      value: {
        account,
        arn: session
          ? `arn:aws:sts::${account}:assumed-role/fake/cloudgate`
          : `arn:aws:iam::${account}:user/fake`,
      },
    });
  }

  assumeRole(
    credential: AwsCredential,
    request: AssumeRoleRequest,
  ): Promise<AwsAnswer<AwsCredential>> {
    this.calls.push({
      method: 'assumeRole',
      accessKeyId: credential.accessKeyId,
      roleArn: request.roleArn,
      externalId: request.externalId,
    });
    if (this.cutOff !== null) return Promise.reject(new Error(this.cutOff));
    if (this.keyRefusal !== null) {
      return refused('InvalidClientTokenId', this.keyRefusal);
    }
    if (this.roleRefusal !== null) {
      return refused('AccessDenied', this.roleRefusal);
    }
    if (request.externalId === null && !this.withoutExternalId) {
      return refused(
        'AccessDenied',
        `User: arn:aws:iam::000000000000:user/fake is not authorized to perform: sts:AssumeRole on resource: ${request.roleArn}`,
      );
    }
    return Promise.resolve({
      ok: true,
      value: {
        accessKeyId: request.roleArn,
        secretAccessKey: 'fake-session-secret',
        sessionToken: SESSION_TOKEN,
      },
    });
  }

  simulatePrincipalPolicy(
    _credential: AwsCredential,
    request: SimulatePolicyRequest,
  ): Promise<AwsAnswer<SimulatedDecision[]>> {
    this.calls.push({
      method: 'simulatePrincipalPolicy',
      policySourceArn: request.policySourceArn,
      actions: request.actions,
      resourceArn: request.resourceArn,
      context: request.context,
    });
    if (this.simulateRefusal !== null) {
      return refused('AccessDenied', this.simulateRefusal);
    }
    return Promise.resolve({
      ok: true,
      value: request.actions.map((action) => ({
        action,
        resourceArn: request.resourceArn,
        decision: this.denied.has(action) ? 'implicitDeny' : 'allowed',
      })),
    });
  }

  ec2DryRun(
    _credential: AwsCredential,
    request: Ec2DryRunRequest,
  ): Promise<AwsAnswer<true>> {
    this.calls.push({
      method: 'ec2DryRun',
      region: request.region,
      action: request.action,
      tags: request.tags,
    });
    const refusal = this.dryRunRefusals.get(request.action);
    if (refusal) return refused(refusal.code, refusal.message);
    // Real EC2 checks IAM before it looks a VPC up, and the deploy role's
    // tag condition on the VPC cannot hold for one that is not there, so a
    // dry run naming a VPC that does not exist is refused.
    if (
      ['CreateSubnet', 'CreateRouteTable', 'CreateSecurityGroup'].includes(
        request.action,
      )
    ) {
      return refused(
        'UnauthorizedOperation',
        `You are not authorized to perform: ec2:${request.action} on resource: vpc/*`,
      );
    }
    return Promise.resolve({ ok: true, value: true });
  }

  countVpcs(
    _credential: AwsCredential,
    region: string,
  ): Promise<AwsAnswer<number>> {
    this.calls.push({ method: 'countVpcs', region });
    return Promise.resolve({ ok: true, value: this.vpcs });
  }

  /**
   * These EC2 dry runs are refused, as an SCP or a region not enabled would
   * refuse them (`UnauthorizedOperation` unless another code is given).
   */
  refuseDryRuns(
    actions: Ec2NetworkAction[],
    code = 'UnauthorizedOperation',
    message = 'You are not authorized to perform this operation.',
  ): void {
    for (const action of actions) {
      this.dryRunRefusals.set(action, { code, message });
    }
  }

  /** Every region holds this many VPCs (1, the default VPC, unless set). */
  vpcCountIs(count: number): void {
    this.vpcs = count;
  }

  plan(request: TofuRunRequest): Promise<TofuPlanOutcome> {
    return this.tofuRun('plan', request).then((outcome) =>
      outcome.ok ? { ok: true, show: outcome.show } : outcome,
    );
  }

  apply(request: TofuApplyRequest): Promise<TofuApplyOutcome> {
    return this.tofuRun('apply', request);
  }

  destroy(request: TofuApplyRequest): Promise<TofuApplyOutcome> {
    return this.tofuRun('destroy', request);
  }

  /**
   * What the state holds, through the adapter's own projection of what
   * `tofu show -json` printed: the state a spec scripted with
   * {@link stateHolds}, else nothing; or the failure scripted for it.
   */
  stateResources(request: TofuStateReadRequest): Promise<TofuStateOutcome> {
    this.calls.push({
      method: 'stateResources',
      stateId: request.stateId,
      region: request.region,
    });
    const failure = this.scripted(request.stateId, null);
    if (failure && failure.kind !== 'hang') {
      return Promise.resolve(failureOutcome(failure, request.stateId));
    }
    const shown = this.states.get(request.stateId) ?? {};
    return Promise.resolve({
      ok: true,
      resources: stateResources(shown, request.region),
    });
  }

  /** The state holds this: a stored `tofu show -json` of a state, by its name in `fixtures/states/`. */
  stateHolds(stateId: string, name: string): void {
    this.states.set(stateId, storedState(name));
  }

  /**
   * Replays the stored plan scripted for the state (an empty plan if none),
   * streams the lines a real run would print, and calls `beforeApply` the
   * way the adapter does; or fails the way it was scripted to.
   */
  private async tofuRun(
    method: 'plan' | 'apply' | 'destroy',
    request: TofuApplyRequest,
  ): Promise<TofuApplyOutcome> {
    const call: Extract<
      FakeCloudCall,
      { method: 'plan' | 'apply' | 'destroy' }
    > = {
      method,
      stateId: request.stateId,
      accessKeyId: request.credential.accessKeyId,
      variables: Object.keys(request.variables ?? {}).sort(),
      ...(request.targets ? { targets: [...request.targets] } : {}),
      ...cpuArchitectureOf(request.definition),
      ...domainsOf(request.definition),
    };
    this.calls.push(call);
    this.tofuInputs.push({
      stateId: request.stateId,
      definition: renderDefinition(request.definition),
      variables: { ...request.variables },
    });
    const line = (text: string) => request.onLine?.(text);
    line('Initializing the backend...');
    line('OpenTofu has been successfully initialized!');
    const kind = definitionKind(request.definition);
    const failure = this.scripted(request.stateId, kind);
    if (failure?.kind === 'hang') return this.hangUntilInterrupted(request);
    if (failure) {
      const outcome = failureOutcome(failure, request.stateId);
      line(`Error: ${outcome.message}`);
      return outcome;
    }
    if (method !== 'plan' && request.forget) {
      const held = this.certificatesHeld.get(request.stateId) ?? [];
      const keyOf = (one: ForgottenInstance) =>
        /\["(.*)"\]$/.exec(one.address)?.[1] ?? '';
      const forgotten = held.filter(
        (one) => !request.forget!.keep.includes(keyOf(one)),
      );
      if (forgotten.length > 0) {
        try {
          await request.forget.before(forgotten);
        } catch (error) {
          return {
            ok: false,
            reason: 'failed',
            message: `Nothing was changed: ${(error as Error).message}`,
          };
        }
        call.forgotten = forgotten.map((one) => one.address);
        this.certificatesHeld.set(
          request.stateId,
          held.filter((one) => !forgotten.includes(one)),
        );
      }
    }
    const replayed =
      this.plans.get(request.stateId) ??
      (kind ? this.plansByKind.get(kind) : undefined) ??
      this.plans.get('*') ??
      EMPTY_PLAN;
    const show = importing(
      request.targets ? targeted(replayed, request.targets) : replayed,
      request.definition,
    );
    if (method === 'plan') return { ok: true, show, outputs: {} };
    const refusal = request.beforeApply?.(show) ?? null;
    if (refusal) return refusal;
    line(
      method === 'destroy'
        ? 'Destroy complete! Resources destroyed.'
        : 'Apply complete!',
    );
    this.followFinalSnapshot(method, request);
    this.followCertificates(method, request);
    return {
      ok: true,
      show,
      outputs: {
        ...domainCertificateOutputs(request.definition),
        ...staticSiteOutputs(request.definition, request.stateId),
        // A targeted apply (the repository first) registers nothing.
        ...(method === 'apply' && !request.targets
          ? this.cronOutputs(request)
          : {}),
        ...this.outputsByState.get(request.stateId),
      },
    };
  }

  /**
   * What a real apply of a Cron service's definition answers: its
   * task definition's newest revision — one more for each apply of the
   * state, as each registers one — its security group and its repository,
   * made from the state so a spec can predict them ({@link fakeTaskDefinitionArn}).
   */
  private cronOutputs(request: TofuApplyRequest): Record<string, unknown> {
    if (definitionKind(request.definition) !== 'cron') return {};
    const resources = (request.definition.resource ?? {}) as Record<
      string,
      Record<string, { family?: string; name?: string }>
    >;
    const family = resources.aws_ecs_task_definition?.service?.family ?? '';
    const repository = resources.aws_ecr_repository?.service?.name ?? '';
    const provider = (request.definition.provider as Record<string, unknown>)
      .aws as { region: string; allowed_account_ids: string[] };
    const account = provider.allowed_account_ids[0];
    const revision = (this.cronRevisions.get(request.stateId) ?? 0) + 1;
    this.cronRevisions.set(request.stateId, revision);
    return {
      task_definition_arn: fakeTaskDefinitionArn(
        provider.region,
        family,
        revision,
      ),
      security_group_id: fakeSecurityGroupId(request.stateId),
      ecr_repository_url: `${account}.dkr.ecr.${provider.region}.amazonaws.com/${repository}`,
    };
  }

  /**
   * The Domain certificates the state holds after this run: an apply's are
   * the definition's (each one a forget left out destroyed), a destroy's
   * none.
   */
  private followCertificates(
    method: 'apply' | 'destroy',
    request: TofuApplyRequest,
  ): void {
    if (method === 'destroy') {
      this.certificatesHeld.delete(request.stateId);
      return;
    }
    const answered = domainCertificateOutputs(request.definition)
      .domain_certificates as Record<string, { arn: string }> | undefined;
    if (!answered) return;
    const block = (
      (request.definition.resource ?? {}) as Record<
        string,
        Record<
          string,
          { for_each?: Record<string, { host: string }>; region?: string }
        >
      >
    ).aws_acm_certificate?.domain;
    this.certificatesHeld.set(
      request.stateId,
      Object.entries(answered).map(([key, { arn }]) => ({
        address: `aws_acm_certificate.domain["${key}"]`,
        arn,
        region: block?.region ?? null,
        domainName: block?.for_each?.[key]?.host ?? null,
      })),
    );
  }

  /**
   * A database's final snapshot as AWS keeps it: an apply records
   * what the definition's instance or replication group would take on
   * delete, and a destroy of that state takes it, sized from the
   * definition (RDS's allocated storage; ElastiCache's a scripted size).
   */
  private followFinalSnapshot(
    method: 'apply' | 'destroy',
    request: TofuApplyRequest,
  ): void {
    if (method === 'destroy') {
      const kept = this.finalSnapshots.get(request.stateId);
      if (!kept) return;
      this.finalSnapshots.delete(request.stateId);
      const provider = (request.definition.provider as Record<string, unknown>)
        ?.aws as { region: string; allowed_account_ids: string[] } | undefined;
      const region = provider?.region ?? 'eu-central-1';
      const account = provider?.allowed_account_ids?.[0] ?? '000000000000';
      this.snapshots.set(`${kept.service}:${kept.name}`, {
        arn: `arn:aws:${kept.service === 'rds' ? 'rds' : 'elasticache'}:${region}:${account}:snapshot:${kept.name}`,
        sizeGb: kept.sizeGb,
      });
      return;
    }
    const resources = (request.definition.resource ?? {}) as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const instance = Object.values(resources.aws_db_instance ?? {})[0];
    const cache = Object.values(
      resources.aws_elasticache_replication_group ?? {},
    )[0];
    if (instance) {
      const name = instance.final_snapshot_identifier;
      if (instance.skip_final_snapshot === false && typeof name === 'string') {
        this.finalSnapshots.set(request.stateId, {
          service: 'rds',
          name,
          sizeGb: Number(instance.allocated_storage) || 20,
        });
      } else {
        this.finalSnapshots.delete(request.stateId);
      }
    }
    if (cache) {
      const name = cache.final_snapshot_identifier;
      if (typeof name === 'string') {
        this.finalSnapshots.set(request.stateId, {
          service: 'elasticache',
          name,
          sizeGb: 0.5,
        });
      } else {
        this.finalSnapshots.delete(request.stateId);
      }
    }
  }

  rdsLiftDeletionProtection(
    _session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<DeletionProtectionLift>> {
    this.calls.push({ method: 'rdsLiftDeletionProtection', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    const scripted = this.protectionLift;
    if (scripted !== null && typeof scripted === 'object') {
      return refused(scripted.code, scripted.message);
    }
    return Promise.resolve({ ok: true, value: scripted ?? 'lifted' });
  }

  rdsSnapshot(
    _session: AwsCredential,
    request: SnapshotRef,
  ): Promise<AwsAnswer<FinalSnapshot | null>> {
    this.calls.push({ method: 'rdsSnapshot', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    return Promise.resolve({
      ok: true,
      value: this.snapshots.get(`rds:${request.name}`) ?? null,
    });
  }

  elastiCacheSnapshot(
    _session: AwsCredential,
    request: SnapshotRef,
  ): Promise<AwsAnswer<FinalSnapshot | null>> {
    this.calls.push({ method: 'elastiCacheSnapshot', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    return Promise.resolve({
      ok: true,
      value: this.snapshots.get(`elasticache:${request.name}`) ?? null,
    });
  }

  /** Every EBS snapshot the fake account holds, by id: a Delete's final one included. */
  readonly volumeSnapshots = new Map<string, VolumeSnapshot>();
  /** The snapshots Data Lifecycle Manager took, by the volume they are of. */
  readonly dailySnapshots = new Map<string, string[]>();
  /** EC2 refuses `CreateSnapshot`, in its own words, when set. */
  snapshotRefusal: { code: string; message: string } | null = null;

  ec2TakeSnapshot(
    _session: AwsCredential,
    request: VolumeSnapshotRequest,
  ): Promise<AwsAnswer<VolumeSnapshot | null>> {
    this.calls.push({ method: 'ec2TakeSnapshot', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    if (this.snapshotRefusal) {
      return refused(this.snapshotRefusal.code, this.snapshotRefusal.message);
    }
    const snapshot: VolumeSnapshot = {
      snapshotId: `snap-${this.volumeSnapshots.size + 1}`,
      state: 'completed',
      sizeGb: 20,
    };
    this.volumeSnapshots.set(snapshot.snapshotId, snapshot);
    return Promise.resolve({ ok: true, value: snapshot });
  }

  ec2Snapshot(
    _session: AwsCredential,
    request: { readonly region: string; readonly snapshotId: string },
  ): Promise<AwsAnswer<VolumeSnapshot | null>> {
    this.calls.push({ method: 'ec2Snapshot', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    return Promise.resolve({
      ok: true,
      value: this.volumeSnapshots.get(request.snapshotId) ?? null,
    });
  }

  ec2DailySnapshots(
    _session: AwsCredential,
    request: { readonly region: string; readonly volumeId: string },
  ): Promise<AwsAnswer<string[]>> {
    this.calls.push({ method: 'ec2DailySnapshots', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    return Promise.resolve({
      ok: true,
      value: [...(this.dailySnapshots.get(request.volumeId) ?? [])],
    });
  }

  ec2DeleteSnapshot(
    _session: AwsCredential,
    request: { readonly region: string; readonly snapshotId: string },
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'ec2DeleteSnapshot', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    for (const [volume, ids] of this.dailySnapshots) {
      this.dailySnapshots.set(
        volume,
        ids.filter((id) => id !== request.snapshotId),
      );
    }
    this.volumeSnapshots.delete(request.snapshotId);
    return Promise.resolve({ ok: true, value: true });
  }

  /** RDS refuses to lift deletion protection, in its own words. */
  refuseProtectionLift(code: string, message: string): void {
    this.protectionLift = { code, message };
  }

  /** The RDS instance a Delete lifts protection on is already gone. */
  noRdsInstance(): void {
    this.protectionLift = 'no-instance';
  }

  /** A final snapshot AWS holds, as a destroy took it. */
  snapshotNamed(
    service: 'rds' | 'elasticache',
    name: string,
  ): FinalSnapshot | undefined {
    return this.snapshots.get(`${service}:${name}`);
  }

  private scripted(
    stateId: string,
    kind: DefinitionKind | null,
  ): ScriptedTofu | undefined {
    return (
      this.tofuFailures.get(stateId) ??
      (kind ? this.failuresByKind.get(kind) : undefined) ??
      this.tofuFailures.get('*')
    );
  }

  private hangUntilInterrupted(
    request: TofuRunRequest,
  ): Promise<TofuApplyOutcome> {
    const interrupted: TofuFailure = {
      ok: false,
      reason: 'interrupted',
      message: 'The run was interrupted; OpenTofu stopped and saved the state.',
    };
    return new Promise((resolve) => {
      request.signal?.onInterrupt(() => resolve(interrupted));
    });
  }

  ecrAuthorizationToken(
    session: AwsCredential,
    region: string,
  ): Promise<AwsAnswer<EcrLogin>> {
    this.calls.push({
      method: 'ecrAuthorizationToken',
      region,
      session: session.sessionToken === SESSION_TOKEN,
    });
    const password = `fake-ecr-password-${this.ecrPasswords.length + 1}-${Math.random().toString(36).slice(2)}`;
    this.ecrPasswords.push(password);
    return Promise.resolve({
      ok: true,
      value: {
        registry: `${accountOf(session.accessKeyId)}.dkr.ecr.${region}.amazonaws.com`,
        username: 'AWS',
        password,
      },
    });
  }

  ecrDeleteImagesExcept(
    _session: AwsCredential,
    request: EcrCleanUpRequest,
  ): Promise<AwsAnswer<{ deleted: number }>> {
    this.calls.push({ method: 'ecrDeleteImagesExcept', ...request });
    return Promise.resolve({ ok: true, value: { deleted: 1 } });
  }

  ecsSetDesiredCount(
    _session: AwsCredential,
    request: EcsServiceRef & { desiredCount: number },
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'ecsSetDesiredCount', ...request });
    return Promise.resolve({ ok: true, value: true });
  }

  ecsForceNewDeployment(
    _session: AwsCredential,
    request: EcsServiceRef,
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'ecsForceNewDeployment', ...request });
    return Promise.resolve({ ok: true, value: true });
  }

  /** `stopping` at once, unless a spec scripted RDS's refusal. */
  rdsStopInstance(
    _session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<RdsInstanceState>> {
    this.calls.push({ method: 'rdsStopInstance', ...request });
    if (this.rdsRefusal) {
      return refused(this.rdsRefusal.code, this.rdsRefusal.message);
    }
    return Promise.resolve({ ok: true, value: { status: 'stopping' } });
  }

  /** `starting` at once, unless a spec scripted RDS's refusal. */
  rdsStartInstance(
    _session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<RdsInstanceState>> {
    this.calls.push({ method: 'rdsStartInstance', ...request });
    if (this.rdsRefusal) {
      return refused(this.rdsRefusal.code, this.rdsRefusal.message);
    }
    return Promise.resolve({ ok: true, value: { status: 'starting' } });
  }

  /** RDS refuses every Stop and Start, in its words. */
  refuseRds(code: string, message: string): void {
    this.rdsRefusal = { code, message };
  }

  /** Steady at once, unless a spec scripted a task that fails to start. */
  ecsRollout(
    _session: AwsCredential,
    request: EcsServiceRef,
  ): Promise<AwsAnswer<EcsRollout>> {
    this.calls.push({ method: 'ecsRollout', ...request });
    if (this.failedStart) {
      return Promise.resolve({
        ok: true,
        value: {
          state: 'failed',
          reason: 'tasks failed to start',
          stoppedTask: {
            taskId: FAILED_TASK_ID,
            stoppedReason: this.failedStart.stoppedReason,
          },
        },
      });
    }
    return Promise.resolve({
      ok: true,
      value: { state: 'completed', reason: null, stoppedTask: null },
    });
  }

  filterLogEvents(
    _session: AwsCredential,
    request: LogEventsRequest,
  ): Promise<AwsAnswer<LogEvent[]>> {
    this.calls.push({ method: 'filterLogEvents', ...request });
    const lines = this.failedStart?.lines ?? [];
    return Promise.resolve({
      ok: true,
      value: lines
        .map((message, index) => ({ timestamp: index, message }))
        .slice(-request.limit),
    });
  }

  /**
   * Every stream under the prefix, from `startTime` on, in the order the
   * events were written (as CloudWatch may hand them back), at most `limit`.
   * A group nothing wrote to does not exist yet.
   */
  filterLogStreams(
    session: AwsCredential,
    request: LogStreamsRequest,
  ): Promise<AwsAnswer<LogStreamsPage>> {
    this.calls.push({
      method: 'filterLogStreams',
      ...request,
      session: session.sessionToken === SESSION_TOKEN,
    });
    if (this.logsRefusal) {
      return refused(this.logsRefusal.code, this.logsRefusal.message);
    }
    const group = this.logGroups.get(request.logGroupName);
    if (!group) {
      return refused(
        'ResourceNotFoundException',
        'The specified log group does not exist.',
      );
    }
    const found = group.filter(
      (event) =>
        event.logStreamName.startsWith(request.logStreamNamePrefix) &&
        event.timestamp >= request.startTime,
    );
    return Promise.resolve({
      ok: true,
      value: {
        events: found.slice(0, request.limit),
        more: found.length > request.limit,
      },
    });
  }

  /** A task of a Service writes these lines to the Service's log group. */
  writeLog(
    logGroupName: string,
    taskId: string,
    lines: { timestamp: number; message: string }[],
  ): void {
    const group = this.logGroups.get(logGroupName) ?? [];
    for (const line of lines) {
      group.push({
        eventId: `event-${group.length + 1}`,
        logStreamName: `service/service/${taskId}`,
        ...line,
      });
    }
    this.logGroups.set(logGroupName, group);
  }

  /** CloudWatch refuses every read of a log group, in AWS's words. */
  refuseLogs(code: string, message: string): void {
    this.logsRefusal = { code, message };
  }

  /** Pending validation, unless a spec scripted the certificate's answer. */
  acmDescribeCertificate(
    _session: AwsCredential,
    request: { region: string; certificateArn: string },
  ): Promise<AwsAnswer<AcmCertificate>> {
    this.calls.push({ method: 'acmDescribeCertificate', ...request });
    return Promise.resolve({
      ok: true,
      value: this.acm.get(request.certificateArn) ??
        this.acm.get('*') ?? { status: 'PENDING_VALIDATION' },
    });
  }

  /**
   * Deleted, unless a spec scripted ACM to call it in use for some deletes
   * ({@link acmInUseFor}); gone once deleted.
   */
  acmDeleteCertificate(
    _session: AwsCredential,
    request: { region: string; certificateArn: string },
  ): Promise<AwsAnswer<AcmDeletion>> {
    this.calls.push({ method: 'acmDeleteCertificate', ...request });
    if (this.acmDeleted.has(request.certificateArn)) {
      return Promise.resolve({ ok: true, value: 'gone' });
    }
    const inUse = this.acmInUse.get(request.certificateArn) ?? 0;
    if (inUse > 0) {
      this.acmInUse.set(request.certificateArn, inUse - 1);
      return Promise.resolve({ ok: true, value: 'in-use' });
    }
    this.acmDeleted.add(request.certificateArn);
    return Promise.resolve({ ok: true, value: 'deleted' });
  }

  /** ACM calls the certificate in use for its next `times` deletes. */
  acmInUseFor(certificateArn: string, times: number): void {
    this.acmInUse.set(certificateArn, times);
  }

  /** Nothing, unless a spec scripted the name's answer. */
  dnsLookup(name: string): Promise<DnsAnswer> {
    this.calls.push({ method: 'dnsLookup', name });
    return Promise.resolve(
      this.dns.get(dnsKey(name)) ?? { cnames: [], addresses: [] },
    );
  }

  /** ACM answers this about the certificate (or, with `*`, every one). */
  acmAnswers(certificateArn: string, answer: AcmCertificate): void {
    this.acm.set(certificateArn, answer);
  }

  /** DNS answers this for the name. */
  dnsAnswers(name: string, answer: Partial<DnsAnswer>): void {
    this.dns.set(dnsKey(name), { cnames: [], addresses: [], ...answer });
  }

  findTagged(
    _session: AwsCredential,
    request: TagSearchRequest,
  ): Promise<AwsAnswer<TaggedResource[]>> {
    this.calls.push({ method: 'findTagged', ...request });
    return Promise.resolve({
      ok: true,
      value: this.leftTagged
        .filter(
          (one) =>
            one.region === request.region &&
            Object.entries(request.tags).every(
              ([key, value]) => one.tags[key] === value,
            ),
        )
        .map(({ arn, tags }) => ({ arn, tags })),
    });
  }

  ecsStanding(
    _session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<EcsStanding>> {
    this.calls.push({ method: 'ecsStanding', ...request });
    return Promise.resolve({
      ok: true,
      value: {
        live: request.arns.filter(
          (arn) => !this.ecsGone.has(arn) && !this.ecsInactive.has(arn),
        ),
        inactiveTaskDefinitions: request.arns.filter((arn) =>
          this.ecsInactive.has(arn),
        ),
      },
    });
  }

  ec2Standing(
    _session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<Ec2Standing>> {
    this.calls.push({ method: 'ec2Standing', ...request });
    if (this.ec2StandingRefusal) {
      return refused(
        this.ec2StandingRefusal.code,
        this.ec2StandingRefusal.message,
      );
    }
    return Promise.resolve({
      ok: true,
      value: { live: request.arns.filter((arn) => !this.ec2Gone.has(arn)) },
    });
  }

  ecsDeleteTaskDefinitions(
    _session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'ecsDeleteTaskDefinitions', ...request });
    for (const arn of request.arns) {
      this.ecsInactive.delete(arn);
      this.ecsGone.add(arn);
    }
    return Promise.resolve({ ok: true, value: true });
  }

  /**
   * A task running at once, unless a spec scripted ECS's refusal to start
   * one. Its ARN carries a running count, so a spec can predict it
   * ({@link fakeTaskArn}).
   */
  ecsRunTask(
    _session: AwsCredential,
    request: EcsRunTaskRequest,
  ): Promise<AwsAnswer<EcsRunTaskOutcome>> {
    this.calls.push({ method: 'ecsRunTask', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    if (this.runTaskRefusal) {
      return Promise.resolve({
        ok: true,
        value: { started: false, reason: this.runTaskRefusal },
      });
    }
    const taskArn = fakeTaskArn(
      request.region,
      request.cluster,
      this.ecsTasks.size + 1,
    );
    this.ecsTasks.set(taskArn, {
      taskArn,
      region: request.region,
      cluster: request.cluster,
      taskDefinitionArn: request.taskDefinitionArn,
      startedBy: request.startedBy,
      tags: { ...request.tags },
      lastStatus: 'RUNNING',
      exitCode: null,
      stoppedReason: null,
    });
    return Promise.resolve({ ok: true, value: { started: true, taskArn } });
  }

  /** Each task ECS still describes; a forgotten one is not in the answer. */
  ecsDescribeTasks(
    _session: AwsCredential,
    request: EcsTasksRef,
  ): Promise<AwsAnswer<EcsTaskState[]>> {
    this.calls.push({ method: 'ecsDescribeTasks', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    return Promise.resolve({
      ok: true,
      value: request.taskArns.flatMap((arn) => {
        const task = this.ecsTasks.get(arn);
        return task
          ? [
              {
                taskArn: task.taskArn,
                lastStatus: task.lastStatus,
                exitCode: task.exitCode,
                stoppedReason: task.stoppedReason,
              },
            ]
          : [];
      }),
    });
  }

  /**
   * Stopped at once, as ECS stops a task: its container killed (137), the
   * stop's reason its `stoppedReason`. A task ECS does not know is gone.
   */
  ecsStopTask(
    _session: AwsCredential,
    request: EcsStopTaskRequest,
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'ecsStopTask', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    if (this.stopTaskRefusal) {
      return refused(this.stopTaskRefusal.code, this.stopTaskRefusal.message);
    }
    const task = this.ecsTasks.get(request.taskArn);
    if (task && task.lastStatus !== 'STOPPED') {
      task.lastStatus = 'STOPPED';
      task.exitCode = 137;
      task.stoppedReason = request.reason;
    }
    return Promise.resolve({ ok: true, value: true });
  }

  /** The stream's events after `from` (an index), oldest first. */
  readLogStream(
    _session: AwsCredential,
    request: LogStreamReadRequest,
  ): Promise<AwsAnswer<LogStreamRead>> {
    this.calls.push({ method: 'readLogStream', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    if (this.logsRefusal) {
      return refused(this.logsRefusal.code, this.logsRefusal.message);
    }
    // A CodeBuild build's own stream: the lines it has written so far.
    const build = [...this.codeBuilds.values()].find(
      (one) => streamOf(one.buildId) === request.logStreamName,
    );
    if (build) {
      const at = request.from === null ? 0 : Number(request.from);
      const lines = (build.script.lines ?? []).slice(0, build.written);
      return Promise.resolve({
        ok: true,
        value: {
          messages: lines.slice(at),
          next: lines.length === 0 ? request.from : String(lines.length),
        },
      });
    }
    const events = (this.logGroups.get(request.logGroupName) ?? []).filter(
      (event) => event.logStreamName === request.logStreamName,
    );
    const at = request.from === null ? 0 : Number(request.from);
    return Promise.resolve({
      ok: true,
      value: {
        messages: events.slice(at).map((event) => event.message),
        next: events.length === 0 ? request.from : String(events.length),
      },
    });
  }

  /** The SecureString parameters SSM holds now, `<region>:<name>` → value. */
  get parameters(): ReadonlyMap<string, { value: string; tagValue: string }> {
    return this.ssmParameters;
  }

  putBuildParameter(
    _session: AwsCredential,
    request: BuildParameterPut,
  ): Promise<AwsAnswer<true>> {
    this.calls.push({
      method: 'putBuildParameter',
      region: request.region,
      name: request.name,
      tagValue: request.tagValue,
    });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    const key = `${request.region}:${request.name}`;
    if (this.ssmParameters.has(key)) {
      return refused(
        'ParameterAlreadyExists',
        'The parameter already exists. To overwrite this value, set the overwrite option in the request to true.',
      );
    }
    this.ssmParameters.set(key, {
      value: request.value,
      tagValue: request.tagValue,
    });
    return Promise.resolve({ ok: true, value: true });
  }

  deleteParameter(
    _session: AwsCredential,
    request: ParameterRef,
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'deleteParameter', ...request });
    this.ssmParameters.delete(`${request.region}:${request.name}`);
    return Promise.resolve({ ok: true, value: true });
  }

  startSshSession(
    _session: AwsCredential,
    request: SshSessionRequest,
  ): Promise<AwsAnswer<SshSession>> {
    this.calls.push({ method: 'startSshSession', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    const sessionId = `cloudgate-${request.instanceId}-${this.calls.length}`;
    return Promise.resolve({
      ok: true,
      value: {
        sessionId,
        streamUrl: `wss://ssmmessages.${request.region}.amazonaws.com/v1/data-channel/${sessionId}`,
        tokenValue: 'fake-session-token',
      },
    });
  }

  terminateSession(
    _session: AwsCredential,
    request: { region: string; sessionId: string },
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'terminateSession', ...request });
    return Promise.resolve({ ok: true, value: true });
  }

  /** `stopped` at once, as a spec reads it next, unless EC2's refusal is scripted. */
  ec2StopInstance(
    _session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>> {
    this.calls.push({ method: 'ec2StopInstance', ...request });
    return this.ec2Moved(request, 'stopped');
  }

  /** `running` at once, unless EC2's refusal is scripted. */
  ec2StartInstance(
    _session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>> {
    this.calls.push({ method: 'ec2StartInstance', ...request });
    return this.ec2Moved(request, 'running');
  }

  /** The state the last Stop or Start left, `running` before either. */
  ec2InstanceState(
    _session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>> {
    this.calls.push({ method: 'ec2InstanceState', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    if (this.ec2InstanceRefusal) {
      return refused(
        this.ec2InstanceRefusal.code,
        this.ec2InstanceRefusal.message,
      );
    }
    return Promise.resolve({
      ok: true,
      value: this.ec2States.get(request.instanceId) ?? 'running',
    });
  }

  /** A Stack VM's EC2 state, as something outside Cloudgate left it. */
  setEc2InstanceState(instanceId: string, state: Ec2InstanceState): void {
    this.ec2States.set(instanceId, state);
  }

  /** EC2 refuses every Stack VM Stop, Start and read, in its words. */
  refuseEc2Instances(code: string, message: string): void {
    this.ec2InstanceRefusal = { code, message };
  }

  private ec2Moved(
    request: Ec2InstanceRef,
    to: Ec2InstanceState,
  ): Promise<AwsAnswer<Ec2InstanceState>> {
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    if (this.ec2InstanceRefusal) {
      return refused(
        this.ec2InstanceRefusal.code,
        this.ec2InstanceRefusal.message,
      );
    }
    this.ec2States.set(request.instanceId, to);
    return Promise.resolve({ ok: true, value: to });
  }

  /** How the next CodeBuild build goes; scripts queue in order. */
  scriptBuild(script: FakeBuildScript): void {
    this.buildScripts.push(script);
  }

  /** Every build CodeBuild started, in order. */
  get builds(): FakeBuild[] {
    return [...this.codeBuilds.values()];
  }

  /** A held build ends, by default succeeding. */
  endBuild(
    buildId: string,
    status: 'SUCCEEDED' | 'FAILED' = 'SUCCEEDED',
  ): void {
    const build = this.codeBuilds.get(buildId);
    if (!build) throw new Error(`No build ${buildId}`);
    build.ended ??= status;
  }

  codeBuildStart(
    _session: AwsCredential,
    request: CodeBuildStartRequest,
  ): Promise<AwsAnswer<{ buildId: string }>> {
    this.calls.push({ method: 'codeBuildStart', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    const script = this.buildScripts.shift() ?? {};
    if (script.refusal) {
      return refused(script.refusal.code, script.refusal.message);
    }
    // StartBuild's idempotency token: one Deployment, one build.
    const same = [...this.codeBuilds.values()].find(
      (one) => one.request.idempotencyToken === request.idempotencyToken,
    );
    if (same)
      return Promise.resolve({ ok: true, value: { buildId: same.buildId } });
    const buildId = `${request.projectName}:0000aaaa-bbbb-4ccc-8ddd-${String(
      this.codeBuilds.size + 1,
    ).padStart(12, '0')}`;
    this.codeBuilds.set(buildId, {
      buildId,
      request,
      script,
      startedAt: Date.now(),
      written: 0,
      ended: null,
      stopAsked: false,
    });
    return Promise.resolve({ ok: true, value: { buildId } });
  }

  /**
   * Where the build is: queued for its `queuedMs`, then running, writing
   * one of its lines per read, then ended once every line is written
   * (unless held).
   */
  codeBuildState(
    _session: AwsCredential,
    request: CodeBuildRef,
  ): Promise<AwsAnswer<CodeBuildState>> {
    this.calls.push({ method: 'codeBuildState', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    const build = this.codeBuilds.get(request.buildId);
    if (!build) {
      return refused(
        'ResourceNotFoundException',
        `Build ${request.buildId} not found`,
      );
    }
    const { script } = build;
    const lines = script.lines ?? [];
    const queued =
      build.ended === null &&
      Date.now() - build.startedAt < (script.queuedMs ?? 0);
    if (!queued && build.ended === null) {
      if (build.written < lines.length) build.written += 1;
      else if (!script.held) build.ended = script.status ?? 'SUCCEEDED';
    }
    const ended = build.ended;
    const exportedVariables: Record<string, string> =
      ended === 'SUCCEEDED'
        ? { CLOUDGATE_IMAGE: script.image ?? 'amd64 null' }
        : {};
    return Promise.resolve({
      ok: true,
      value: {
        phase: ended ? 'ended' : queued ? 'queued' : 'running',
        status: ended ?? 'IN_PROGRESS',
        reason:
          ended && ended !== 'SUCCEEDED' && ended !== 'STOPPED'
            ? (script.reason ?? null)
            : null,
        logStreamName: queued ? null : streamOf(build.buildId),
        exportedVariables,
      },
    });
  }

  codeBuildStop(
    _session: AwsCredential,
    request: CodeBuildRef,
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'codeBuildStop', ...request });
    const build = this.codeBuilds.get(request.buildId);
    if (build) {
      build.stopAsked = true;
      build.ended ??= 'STOPPED';
    }
    return Promise.resolve({ ok: true, value: true });
  }

  /** Every task ECS started for a Cron service run, in order. */
  get tasksStarted(): FakeEcsTask[] {
    return [...this.ecsTasks.values()];
  }

  /** The task's container ends by itself with this exit code. */
  endTask(taskArn: string, exitCode: number): void {
    const task = this.ecsTasks.get(taskArn);
    if (!task) throw new Error(`No task ${taskArn}`);
    task.lastStatus = 'STOPPED';
    task.exitCode = exitCode;
    task.stoppedReason = 'Essential container in task exited';
  }

  /**
   * The task stopped before its container ran, as ECS says when it cannot
   * pull the image or reach a secret: no exit code, only its reason.
   */
  stopTaskUnstarted(taskArn: string, stoppedReason: string): void {
    const task = this.ecsTasks.get(taskArn);
    if (!task) throw new Error(`No task ${taskArn}`);
    task.lastStatus = 'STOPPED';
    task.exitCode = null;
    task.stoppedReason = stoppedReason;
  }

  /** ECS no longer describes the task (it keeps a stopped one about an hour). */
  forgetTask(taskArn: string): void {
    this.ecsTasks.delete(taskArn);
  }

  /** The task's container prints these lines into its own log stream. */
  printTask(logGroupName: string, taskArn: string, lines: string[]): void {
    this.writeLog(
      logGroupName,
      taskArn.split('/').pop() ?? '',
      lines.map((message, at) => ({ timestamp: at, message })),
    );
  }

  /** ECS starts no task, answering `failures` with this reason. */
  refuseTaskStart(reason: string): void {
    this.runTaskRefusal = reason;
  }

  /** ECS refuses every `StopTask`, in AWS's words. */
  refuseTaskStop(code: string, message: string): void {
    this.stopTaskRefusal = { code, message };
  }

  findIamRole(
    _session: AwsCredential,
    roleName: string,
  ): Promise<AwsAnswer<{ arn: string } | null>> {
    this.calls.push({ method: 'findIamRole', roleName });
    const arn = this.leftRoles.get(roleName);
    return Promise.resolve({ ok: true, value: arn ? { arn } : null });
  }

  networkInterfacesOf(
    _session: AwsCredential,
    request: NetworkInterfacesRequest,
  ): Promise<AwsAnswer<NetworkInterface[]>> {
    this.calls.push({ method: 'networkInterfacesOf', ...request });
    return Promise.resolve({
      ok: true,
      value: this.leftCards
        .filter(
          (card) =>
            card.region === request.region &&
            card.securityGroupIds.some((id) =>
              request.securityGroupIds.includes(id),
            ),
        )
        .map(({ networkInterfaceId, securityGroupIds, description }) => ({
          networkInterfaceId,
          securityGroupIds,
          description,
        })),
    });
  }

  /**
   * What RDS holds of the instance, once a spec says it has one: RDS
   * refuses an instance it does not have, as AWS does.
   */
  rdsBackups(
    session: AwsCredential,
    request: CloudDatabaseRef,
  ): Promise<AwsAnswer<RdsBackups>> {
    this.calls.push({
      method: 'rdsBackups',
      ...request,
      session: session.sessionToken === SESSION_TOKEN,
    });
    if (this.backupsRefusal) {
      return refused(this.backupsRefusal.code, this.backupsRefusal.message);
    }
    const held = this.rdsHeld.get(request.identifier);
    if (!held) {
      return refused(
        'DBInstanceNotFoundFault',
        `DBInstance ${request.identifier} not found.`,
      );
    }
    return Promise.resolve({ ok: true, value: held });
  }

  /** What ElastiCache holds of the replication group, once a spec says it has one. */
  cacheBackups(
    session: AwsCredential,
    request: CloudDatabaseRef,
  ): Promise<AwsAnswer<CacheBackups>> {
    this.calls.push({
      method: 'cacheBackups',
      ...request,
      session: session.sessionToken === SESSION_TOKEN,
    });
    if (this.backupsRefusal) {
      return refused(this.backupsRefusal.code, this.backupsRefusal.message);
    }
    const held = this.cacheHeld.get(request.identifier);
    if (!held) {
      return refused(
        'ReplicationGroupNotFoundFault',
        `ReplicationGroup ${request.identifier} not found.`,
      );
    }
    return Promise.resolve({ ok: true, value: held });
  }

  /** RDS has this instance, holding these backups. */
  rdsHolds(identifier: string, backups: RdsBackups): void {
    this.rdsHeld.set(identifier, backups);
  }

  /** ElastiCache has this replication group, holding these backups. */
  cacheHolds(identifier: string, backups: CacheBackups): void {
    this.cacheHeld.set(identifier, backups);
  }

  /** Every read of a database's backups is refused, in AWS's words. */
  refuseBackupReads(code: string, message: string): void {
    this.backupsRefusal = { code, message };
  }

  /** A tag search in `region` finds this resource, as one a destroy left. */
  leaveTagged(region: string, arn: string, tags: Record<string, string>): void {
    this.leftTagged.push({ region, arn, tags });
  }

  /**
   * The tag search finds this ECS resource, but ECS says it is stopped or
   * deleted (`gone`) or a deregistered task definition (`inactive`): what
   * AWS's tag index keeps after a real destroy.
   */
  leaveEcsGhost(
    region: string,
    arn: string,
    tags: Record<string, string>,
    as: 'gone' | 'inactive',
  ): void {
    this.leftTagged.push({ region, arn, tags });
    (as === 'gone' ? this.ecsGone : this.ecsInactive).add(arn);
  }

  /**
   * The tag search finds this EC2 resource, but EC2 answers
   * `Invalid…ID.NotFound` for it: what AWS's tag index keeps after a real
   * destroy.
   */
  leaveEc2Ghost(
    region: string,
    arn: string,
    tags: Record<string, string>,
  ): void {
    this.leftTagged.push({ region, arn, tags });
    this.ec2Gone.add(arn);
  }

  /** Every `ec2Standing` is refused, in AWS's words. */
  refuseEc2Standing(code: string, message: string): void {
    this.ec2StandingRefusal = { code, message };
  }

  /** `iam:GetRole` finds this role, as one a destroy left. */
  leaveIamRole(roleName: string, arn: string): void {
    this.leftRoles.set(roleName, arn);
  }

  /** A network card AWS made is still on this security group. */
  leaveNetworkInterface(
    region: string,
    networkInterfaceId: string,
    securityGroupId: string,
  ): void {
    this.leftCards.push({
      region,
      networkInterfaceId,
      securityGroupIds: [securityGroupId],
      description: 'arn:aws:ecs:attachment',
    });
  }

  /** Nothing is left any more: the next check finds AWS clean. */
  clearLeftovers(): void {
    this.leftTagged = [];
    this.ecsGone.clear();
    this.ecsInactive.clear();
    this.ec2Gone.clear();
    this.leftRoles.clear();
    this.leftCards = [];
  }

  /** AWS cannot be reached: taking on a role throws, as with no network. */
  unreachable(message = 'connect ETIMEDOUT sts.amazonaws.com:443'): void {
    this.cutOff = message;
  }

  /** Every new task stops with this reason, having printed these lines. */
  failTaskStart(stoppedReason: string, lines: string[]): void {
    this.failedStart = { stoppedReason, lines };
  }

  /** Every plan of this state (or of every state) is this stored real plan file. */
  replayPlan(name: string, stateId = '*'): void {
    this.plans.set(stateId, storedPlan(name));
  }

  /** Every plan of a definition of this kind is this stored real plan file. */
  replayPlanFor(kind: DefinitionKind, name: string): void {
    this.plansByKind.set(kind, storedPlan(name));
  }

  /** Every plan of a definition of this kind is this plan, a stored one a spec changed. */
  replayShowFor(kind: DefinitionKind, show: TofuShow): void {
    this.plansByKind.set(kind, show);
  }

  /** Every run of a definition of this kind fails, AWS's words in `message`. */
  failRunFor(kind: DefinitionKind, message: string): void {
    this.failuresByKind.set(kind, { kind: 'failed', message });
  }

  /** Runs of a definition of this kind succeed again. */
  passRunFor(kind: DefinitionKind): void {
    this.failuresByKind.delete(kind);
  }

  /** Every run of a definition of this kind never ends until interrupted. */
  hangFor(kind: DefinitionKind): void {
    this.failuresByKind.set(kind, { kind: 'hang' });
  }

  /** What `tofu output -json` answers after this state's apply. */
  outputsFor(stateId: string, outputs: Record<string, unknown>): void {
    this.outputsByState.set(stateId, outputs);
  }

  /** OpenTofu's advisory lock on the state is held by another run. */
  lockHeld(stateId = '*'): void {
    this.tofuFailures.set(stateId, { kind: 'lock-held' });
  }

  /** The state cannot be decrypted. */
  unreadableState(stateId = '*'): void {
    this.tofuFailures.set(stateId, { kind: 'unreadable-state' });
  }

  /** The run never ends until its signal interrupts it. */
  hang(stateId = '*'): void {
    this.tofuFailures.set(stateId, { kind: 'hang' });
  }

  /** `tofu` fails, AWS's words in `message`. */
  failRun(message: string, stateId = '*'): void {
    this.tofuFailures.set(stateId, { kind: 'failed', message });
  }

  /** Runs that {@link failRun} scripted for `stateId` succeed again. */
  passRun(stateId = '*'): void {
    this.tofuFailures.delete(stateId);
  }

  /** The installed OpenTofu or provider is not the pin. */
  installMismatch(message: string, stateId = '*'): void {
    this.tofuFailures.set(stateId, { kind: 'install-mismatch', message });
  }

  /** AWS refuses the access key itself. */
  rejectKey(
    message = 'The security token included in the request is invalid.',
  ): void {
    this.keyRefusal = message;
  }

  /** The key signs in but cannot take on the role, even with the external id. */
  refuseRole(message: string): void {
    this.roleRefusal = message;
  }

  /** The role's trust policy does not require the external id. */
  worksWithoutExternalId(): void {
    this.withoutExternalId = true;
  }

  /** Every identity answers this account, whatever the role ARN says. */
  identityIs(account: string): void {
    this.identityAccount = account;
  }

  /** The simulation denies these actions. */
  denyActions(actions: string[]): void {
    for (const action of actions) this.denied.add(action);
  }

  /** The simulation call itself is refused. */
  refuseSimulation(message: string): void {
    this.simulateRefusal = message;
  }

  /**
   * A switch takes at once; its distribution then reads `InProgress` for
   * the next {@link holdDistribution} reads, and `Deployed` after.
   */
  cloudFrontSwitchOrigin(
    _session: AwsCredential,
    request: OriginSwitchRequest,
  ): Promise<AwsAnswer<true>> {
    this.calls.push({ method: 'cloudFrontSwitchOrigin', ...request });
    if (this.cutOff) return Promise.reject(new Error(this.cutOff));
    if (this.switchRefusal) {
      const { code, message } = this.switchRefusal;
      this.switchRefusal = null;
      return refused(code, message);
    }
    this.originPaths.set(request.distributionId, request.originPath);
    this.distributionPolls = 0;
    return Promise.resolve({ ok: true, value: true });
  }

  cloudFrontCreateInvalidation(
    _session: AwsCredential,
    request: InvalidationRequest,
  ): Promise<AwsAnswer<{ invalidationId: string }>> {
    this.calls.push({
      method: 'cloudFrontCreateInvalidation',
      ...request,
      paths: [...request.paths],
    });
    if (this.invalidationRefusal) {
      const { code, message } = this.invalidationRefusal;
      this.invalidationRefusal = null;
      return refused(code, message);
    }
    const invalidationId = `I${String(this.invalidations.size + 1).padStart(13, '0')}`;
    this.invalidations.set(invalidationId, {
      distributionId: request.distributionId,
      paths: [...request.paths],
      polls: 0,
    });
    return Promise.resolve({ ok: true, value: { invalidationId } });
  }

  cloudFrontDistributionStatus(
    _session: AwsCredential,
    distributionId: string,
  ): Promise<AwsAnswer<DistributionStatus>> {
    this.calls.push({ method: 'cloudFrontDistributionStatus', distributionId });
    this.distributionPolls += 1;
    return Promise.resolve({
      ok: true,
      value:
        this.distributionPolls <= this.distributionHeld
          ? 'InProgress'
          : 'Deployed',
    });
  }

  cloudFrontInvalidationStatus(
    _session: AwsCredential,
    request: { distributionId: string; invalidationId: string },
  ): Promise<AwsAnswer<InvalidationStatus>> {
    this.calls.push({ method: 'cloudFrontInvalidationStatus', ...request });
    const found = this.invalidations.get(request.invalidationId);
    if (!found) {
      return refused(
        'NoSuchInvalidation',
        'The specified invalidation does not exist.',
      );
    }
    found.polls += 1;
    return Promise.resolve({
      ok: true,
      value: found.polls <= this.invalidationHeld ? 'InProgress' : 'Completed',
    });
  }

  /**
   * Holds every switched distribution `InProgress` for this many status
   * reads; `Infinity` holds it there for good, as a stuck CloudFront.
   */
  holdDistribution(reads = Infinity): void {
    this.distributionHeld = reads;
  }

  /** Holds every invalidation `InProgress` for this many status reads. */
  holdInvalidation(reads = Infinity): void {
    this.invalidationHeld = reads;
  }

  /** CloudFront refuses the next origin switch, in AWS's words. */
  refuseOriginSwitch(code: string, message: string): void {
    this.switchRefusal = { code, message };
  }

  /** CloudFront refuses the next cache clear, in AWS's words. */
  refuseInvalidation(code: string, message: string): void {
    this.invalidationRefusal = { code, message };
  }

  /** The distribution's origin path, as the last switch left it. */
  originPathOf(distributionId: string): string | undefined {
    return this.originPaths.get(distributionId);
  }

  /** Back to "AWS says yes", with no calls recorded. */
  reset(): void {
    this.calls.length = 0;
    this.ec2States.clear();
    this.ec2InstanceRefusal = null;
    this.keyRefusal = null;
    this.roleRefusal = null;
    this.withoutExternalId = false;
    this.identityAccount = null;
    this.denied.clear();
    this.simulateRefusal = null;
    this.dryRunRefusals.clear();
    this.vpcs = 1;
    this.plans.clear();
    this.outputsByState.clear();
    this.tofuFailures.clear();
    this.plansByKind.clear();
    this.failuresByKind.clear();
    this.volumeSnapshots.clear();
    this.dailySnapshots.clear();
    this.snapshotRefusal = null;
    this.ecrPasswords.length = 0;
    this.tofuInputs.length = 0;
    this.failedStart = null;
    this.logGroups.clear();
    this.logsRefusal = null;
    this.rdsRefusal = null;
    this.acm.clear();
    this.acmInUse.clear();
    this.acmDeleted.clear();
    this.certificatesHeld.clear();
    this.dns.clear();
    this.clearLeftovers();
    this.cutOff = null;
    this.states.clear();
    this.rdsHeld.clear();
    this.cacheHeld.clear();
    this.backupsRefusal = null;
    this.ec2StandingRefusal = null;
    this.originPaths.clear();
    this.invalidations.clear();
    this.distributionPolls = 0;
    this.distributionHeld = 0;
    this.invalidationHeld = 0;
    this.switchRefusal = null;
    this.invalidationRefusal = null;
    this.finalSnapshots.clear();
    this.snapshots.clear();
    this.protectionLift = null;
    this.ecsTasks.clear();
    this.cronRevisions.clear();
    this.runTaskRefusal = null;
    this.stopTaskRefusal = null;
    this.buildScripts = [];
    this.codeBuilds.clear();
    this.ssmParameters.clear();
  }
}

/** CodeBuild names a build's log stream by the id after the project. */
function streamOf(buildId: string): string {
  return buildId.slice(buildId.indexOf(':') + 1);
}

/** The ARN of the `revision`th task definition a Cron service's applies registered. */
export function fakeTaskDefinitionArn(
  region: string,
  family: string,
  revision: number,
): string {
  return `arn:aws:ecs:${region}:123456789012:task-definition/${family}:${revision}`;
}

/** The security group id the fake's apply of a Cron service's state answers. */
export function fakeSecurityGroupId(stateId: string): string {
  return `sg-${stateId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()}`;
}

/** The ARN the fake gives the `count`th task it starts in a cluster. */
export function fakeTaskArn(
  region: string,
  cluster: string,
  count: number,
): string {
  const name = cluster.split('/').pop() ?? cluster;
  return `arn:aws:ecs:${region}:123456789012:task/${name}/${count.toString(16).padStart(32, '0')}`;
}

function dnsKey(name: string): string {
  return name.toLowerCase().replace(/\.$/, '');
}

/**
 * The distribution id a real apply of a `static` site answers, made
 * from its state so a spec can predict it ({@link fakeDistributionId}).
 */
function staticSiteOutputs(
  definition: Record<string, unknown>,
  stateId: string,
): Record<string, unknown> {
  if (definitionKind(definition) !== 'static') return {};
  const id = fakeDistributionId(stateId);
  return {
    distribution_id: id,
    distribution_arn: `arn:aws:cloudfront::123456789012:distribution/${id}`,
    distribution_domain: `${id.toLowerCase()}.cloudfront.net`,
  };
}

/** The distribution id the fake's apply of a `static` site's state answers. */
export function fakeDistributionId(stateId: string): string {
  return `E${stateId
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 13)
    .toUpperCase()}`;
}

/**
 * What a real apply answers for a Service's Domain certificates: each
 * certificate in the definition, under its key, with an ARN and the
 * validation CNAME ACM would name, made from the key so a spec can predict
 * them ({@link fakeCertificateArn}, {@link fakeValidationRecord}).
 */
function domainCertificateOutputs(
  definition: Record<string, unknown>,
): Record<string, unknown> {
  const resources = (definition.resource ?? {}) as Record<
    string,
    Record<
      string,
      { for_each?: Record<string, { host: string }>; region?: string }
    >
  >;
  const block = resources.aws_acm_certificate?.domain;
  const certificates = block?.for_each;
  if (!certificates) return {};
  const provider = (definition.provider as Record<string, unknown>).aws as {
    region: string;
    allowed_account_ids: string[];
  };
  return {
    domain_certificates: Object.fromEntries(
      Object.entries(certificates).map(([key, { host }]) => [
        key,
        {
          // A static site's is in us-east-1, by its own `region`.
          arn: fakeCertificateArn(
            block.region ?? provider.region,
            provider.allowed_account_ids[0],
            key,
          ),
          validation: [fakeValidationRecord(key, host)],
        },
      ]),
    ),
  };
}

/** The ARN the fake gives the certificate under `key`. */
export function fakeCertificateArn(
  region: string,
  account: string,
  key: string,
): string {
  return `arn:aws:acm:${region}:${account}:certificate/${key}`;
}

/** The validation CNAME the fake has ACM name for the certificate under `key`. */
export function fakeValidationRecord(
  key: string,
  host: string,
): { name: string; type: string; value: string } {
  const label = `_${key.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  return {
    name: `${label}.${host}.`,
    type: 'CNAME',
    value: `${label}.acm-validations.aws.`,
  };
}

/** The id of the task a scripted failed start names. */
export const FAILED_TASK_ID = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';

/** The task definition's `runtime_platform.cpu_architecture`, if any. */
function cpuArchitectureOf(definition: Record<string, unknown>): {
  cpuArchitecture?: string;
} {
  const resources = (definition.resource ?? {}) as Record<
    string,
    Record<string, { runtime_platform?: { cpu_architecture?: string } }>
  >;
  const task = Object.values(resources.aws_ecs_task_definition ?? {})[0];
  const found = task?.runtime_platform?.cpu_architecture;
  return found ? { cpuArchitecture: found } : {};
}

/** The Domain certificates a Service definition holds, if it holds the blocks. */
function domainsOf(definition: Record<string, unknown>): {
  domainCertificates?: string[];
  attachedCertificates?: string[];
  distributionAliases?: string[];
} {
  const resources = (definition.resource ?? {}) as Record<
    string,
    Record<
      string,
      { for_each?: Record<string, unknown>; aliases?: string[] } | undefined
    >
  >;
  const keys = (type: string) =>
    Object.keys(resources[type]?.domain?.for_each ?? {}).sort();
  if (!resources.aws_acm_certificate?.domain) return {};
  // A static site's Domain is an alternate domain name of its
  // distribution, not a listener certificate.
  const distribution = resources.aws_cloudfront_distribution?.site;
  if (distribution) {
    return {
      domainCertificates: keys('aws_acm_certificate'),
      distributionAliases: [...(distribution.aliases ?? [])],
    };
  }
  return {
    domainCertificates: keys('aws_acm_certificate'),
    attachedCertificates: keys('aws_lb_listener_certificate'),
  };
}

/**
 * The plan with each address an `import` block names marked as importing
 * that id, as OpenTofu's plan of a config-driven import marks it.
 */
function importing(
  show: TofuShow,
  definition: Record<string, unknown>,
): TofuShow {
  const imports = (definition.import ?? []) as { to: string; id: string }[];
  if (imports.length === 0) return show;
  const changes = (show.resource_changes ?? []) as {
    address: string;
    change: Record<string, unknown>;
  }[];
  return {
    ...show,
    resource_changes: changes.map((one) => {
      const found = imports.find((block) => block.to === one.address);
      return found
        ? { ...one, change: { ...one.change, importing: { id: found.id } } }
        : one;
    }),
  };
}

/** A plan limited to `targets`, as `tofu plan -target` would make it. */
function targeted(show: TofuShow, targets: readonly string[]): TofuShow {
  const changes = (show.resource_changes ?? []) as { address: string }[];
  return {
    ...show,
    // A target naming a block takes each of its instances (`for_each`).
    resource_changes: changes.filter((change) =>
      targets.some(
        (target) =>
          change.address === target || change.address.startsWith(`${target}[`),
      ),
    ),
  };
}

function accountOf(roleArn: string): string {
  return /^arn:aws[a-z-]*:iam::(\d{12}):/.exec(roleArn)?.[1] ?? '000000000000';
}

function refused<T>(code: string, message: string): Promise<AwsAnswer<T>> {
  return Promise.resolve({ ok: false, code, message });
}

/** The adapter's answer for a scripted failure, in its words. */
function failureOutcome(
  failure: Exclude<ScriptedTofu, { kind: 'hang' }>,
  stateId: string,
): TofuFailure {
  switch (failure.kind) {
    case 'lock-held':
      return {
        ok: false,
        reason: 'lock-held',
        message: `Another run is using this state (Infrastructure state ${stateId}). Try again when it has finished.`,
        failedAt: 'plan',
      };
    case 'unreadable-state':
      return {
        ok: false,
        reason: 'unreadable-state',
        message: `Cloudgate cannot read Infrastructure state ${stateId}: decryption failed for all provided methods. Nothing was changed, and the state is left as it is.`,
        failedAt: 'plan',
      };
    case 'install-mismatch':
      return {
        ok: false,
        reason: 'install-mismatch',
        message: failure.message,
      };
    case 'failed':
      // As the cloud refuses a definition: at its apply.
      return {
        ok: false,
        reason: 'failed',
        message: failure.message,
        failedAt: 'apply',
      };
  }
}
