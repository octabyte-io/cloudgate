import { Injectable } from '@nestjs/common';
import type { BeforeApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import { promises as dns } from 'node:dns';
import {
  ACMClient,
  ACMServiceException,
  DeleteCertificateCommand,
  DescribeCertificateCommand,
} from '@aws-sdk/client-acm';
import {
  CloudFrontClient,
  CloudFrontServiceException,
  CreateInvalidationCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  GetInvalidationCommand,
  UpdateDistributionCommand,
} from '@aws-sdk/client-cloudfront';
import {
  CreateInternetGatewayCommand,
  CreateRouteTableCommand,
  CreateSecurityGroupCommand,
  CreateSubnetCommand,
  CreateSnapshotCommand,
  CreateVpcCommand,
  DeleteSnapshotCommand,
  DescribeInstancesCommand,
  DescribeInternetGatewaysCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSnapshotsCommand as DescribeEc2SnapshotsCommand,
  DescribeSubnetsCommand,
  DescribeVpcsCommand,
  EC2Client,
  EC2ServiceException,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';
import type {
  InstanceStateName,
  ResourceType,
  TagSpecification,
} from '@aws-sdk/client-ec2';
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  CodeBuildServiceException,
  StartBuildCommand,
  StopBuildCommand,
} from '@aws-sdk/client-codebuild';
import type { Build } from '@aws-sdk/client-codebuild';
import {
  DeleteParameterCommand,
  ParameterNotFound,
  PutParameterCommand,
  SSMClient,
  SSMServiceException,
  StartSessionCommand,
  TerminateSessionCommand,
} from '@aws-sdk/client-ssm';
import {
  CloudWatchLogsClient,
  CloudWatchLogsServiceException,
  FilterLogEventsCommand,
  GetLogEventsCommand,
  ResourceNotFoundException as LogsResourceNotFound,
} from '@aws-sdk/client-cloudwatch-logs';
import type { GetLogEventsCommandOutput } from '@aws-sdk/client-cloudwatch-logs';
import {
  BatchDeleteImageCommand,
  ECRClient,
  ECRServiceException,
  GetAuthorizationTokenCommand,
  ListImagesCommand,
} from '@aws-sdk/client-ecr';
import type { ImageIdentifier } from '@aws-sdk/client-ecr';
import {
  DeleteTaskDefinitionsCommand,
  DescribeClustersCommand,
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ECSClient,
  ECSServiceException,
  InvalidParameterException,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  UpdateServiceCommand,
} from '@aws-sdk/client-ecs';
import type { Task } from '@aws-sdk/client-ecs';
import {
  GetRoleCommand,
  IAMClient,
  IAMServiceException,
  NoSuchEntityException,
  SimulatePrincipalPolicyCommand,
} from '@aws-sdk/client-iam';
import type { EvaluationResult } from '@aws-sdk/client-iam';
import {
  DescribeReplicationGroupsCommand,
  DescribeSnapshotsCommand,
  ElastiCacheClient,
  ElastiCacheServiceException,
  SnapshotNotFoundFault,
} from '@aws-sdk/client-elasticache';
import {
  DBInstanceNotFoundFault,
  DBSnapshotNotFoundFault,
  DescribeDBInstanceAutomatedBackupsCommand,
  DescribeDBInstancesCommand,
  DescribeDBSnapshotsCommand,
  ModifyDBInstanceCommand,
  RDSClient,
  RDSServiceException,
  StartDBInstanceCommand,
  StopDBInstanceCommand,
} from '@aws-sdk/client-rds';
import type { DBInstance } from '@aws-sdk/client-rds';
import {
  GetResourcesCommand,
  ResourceGroupsTaggingAPIClient,
  ResourceGroupsTaggingAPIServiceException,
} from '@aws-sdk/client-resource-groups-tagging-api';
import {
  AssumeRoleCommand,
  GetCallerIdentityCommand,
  STSClient,
  STSServiceException,
} from '@aws-sdk/client-sts';

import type {
  AcmCertificate,
  AcmDeletion,
  AssumeRoleRequest,
  AwsAnswer,
  AwsCloudPort,
  AwsCredential,
  BuildParameterPut,
  CacheBackups,
  CallerIdentity,
  CloudDatabaseRef,
  CodeBuildRef,
  CodeBuildStartRequest,
  CodeBuildState,
  DatabaseSnapshot,
  DistributionStatus,
  DeletionProtectionLift,
  FinalSnapshot,
  DnsAnswer,
  Ec2DryRunRequest,
  Ec2InstanceRef,
  Ec2InstanceState,
  EcrCleanUpRequest,
  EcrLogin,
  EcsRollout,
  EcsRunTaskOutcome,
  EcsRunTaskRequest,
  Ec2Standing,
  EcsStanding,
  EcsServiceRef,
  EcsStopTaskRequest,
  EcsTaskState,
  EcsTasksRef,
  LogEvent,
  LogEventsRequest,
  LogStreamRead,
  LogStreamReadRequest,
  InvalidationRequest,
  InvalidationStatus,
  LogStreamsPage,
  LogStreamsRequest,
  NetworkInterface,
  NetworkInterfacesRequest,
  RdsBackups,
  RdsInstanceRef,
  RdsInstanceState,
  OriginSwitchRequest,
  ParameterRef,
  SshSession,
  SshSessionRequest,
  SimulatedDecision,
  SnapshotRef,
  VolumeSnapshot,
  VolumeSnapshotRequest,
  StoppedTask,
  SimulatePolicyRequest,
  StreamLogEvent,
  TaggedResource,
  TagSearchRequest,
  TofuApplyOutcome,
  TofuApplyRequest,
  TofuPlanOutcome,
  TofuRunRequest,
  TofuStateOutcome,
  TofuStateReadRequest,
} from '../cloud.port';
import { SSH_SESSION_DOCUMENT } from '../cloud.port';
import type { Env } from '../../common/config/env.schema';
import { TofuRunner } from '../tofu/tofu-runner';
import { CLOUD_ACCOUNT_TAG_KEY } from './setup-template';
import { stateResources } from './state-resources';

/**
 * STS and IAM are reached through their global endpoints, which live in
 * us-east-1; a Cloud account has no region of its own.
 */
const GLOBAL_REGION = 'us-east-1';

/** The shortest session STS allows; a check needs a few seconds of it. */
const CHECK_SESSION_SECONDS = 900;

/**
 * The cloud port's AWS implementation, and **the only file in `src` that
 * imports the AWS SDK** (the AWS spec, "The cloud port"). Each call builds a
 * client for the credential it is handed rather than holding one, because no
 * credential is Cloudgate's own: each belongs to one Cloud account, and a
 * client kept between calls would be a place for one Cloud account's
 * credential to answer another's request.
 */
@Injectable()
export class AwsCloudAdapter
  implements AwsCloudPort, BeforeApplicationShutdown
{
  /** The only spawner of `tofu` in the backend. */
  private readonly tofu: TofuRunner;

  constructor(config: ConfigService<Env, true>) {
    this.tofu = new TofuRunner({
      binary: config.get('OPENTOFU_BINARY', { infer: true }),
      providerMirror: config.get('OPENTOFU_PROVIDER_MIRROR', { infer: true }),
      stateDatabaseUrl: config.get('INFRASTRUCTURE_STATE_DATABASE_URL', {
        infer: true,
      }),
      appEncryptionSecret: config.get('APP_ENCRYPTION_SECRET', {
        infer: true,
      }),
      // The service runs from `backend/` (deploy/systemd), beside `deploy/`.
      pinsDirectory: resolve(process.cwd(), '..', 'deploy', 'opentofu'),
    });
  }

  plan(request: TofuRunRequest): Promise<TofuPlanOutcome> {
    return this.tofu.plan(request);
  }

  apply(request: TofuApplyRequest): Promise<TofuApplyOutcome> {
    return this.tofu.apply(request);
  }

  destroy(request: TofuApplyRequest): Promise<TofuApplyOutcome> {
    return this.tofu.destroy(request);
  }

  stateResources(request: TofuStateReadRequest): Promise<TofuStateOutcome> {
    return this.tofu.stateResources(request, (show) =>
      stateResources(show, request.region),
    );
  }

  /**
   * Shutdown waits for every running `tofu` to finish or save its state
   * (the AWS spec, "Shutdown"); systemd allows it 5 minutes.
   */
  beforeApplicationShutdown(): Promise<void> {
    return this.tofu.whenIdle();
  }

  callerIdentity(
    credential: AwsCredential,
  ): Promise<AwsAnswer<CallerIdentity>> {
    return answer(async () => {
      const found = await sts(credential).send(
        new GetCallerIdentityCommand({}),
      );
      return { account: found.Account ?? '', arn: found.Arn ?? '' };
    });
  }

  assumeRole(
    credential: AwsCredential,
    request: AssumeRoleRequest,
  ): Promise<AwsAnswer<AwsCredential>> {
    return answer(async () => {
      const { Credentials } = await sts(credential).send(
        new AssumeRoleCommand({
          RoleArn: request.roleArn,
          RoleSessionName: request.sessionName,
          DurationSeconds: CHECK_SESSION_SECONDS,
          ...(request.externalId === null
            ? {}
            : { ExternalId: request.externalId }),
        }),
      );
      if (
        !Credentials?.AccessKeyId ||
        !Credentials.SecretAccessKey ||
        !Credentials.SessionToken
      ) {
        throw new Error('STS answered AssumeRole without credentials');
      }
      return {
        accessKeyId: Credentials.AccessKeyId,
        secretAccessKey: Credentials.SecretAccessKey,
        sessionToken: Credentials.SessionToken,
      };
    });
  }

  simulatePrincipalPolicy(
    credential: AwsCredential,
    request: SimulatePolicyRequest,
  ): Promise<AwsAnswer<SimulatedDecision[]>> {
    return answer(async () => {
      // A check is a couple of dozen simulations back to back, and IAM
      // throttles SimulatePrincipalPolicy well before that: with the SDK's
      // default three attempts a real account's connect failed on "Rate
      // exceeded" every time. Adaptive retries pace the calls instead.
      const client = new IAMClient({
        region: GLOBAL_REGION,
        credentials: credential,
        maxAttempts: 10,
        retryMode: 'adaptive',
      });
      const results: EvaluationResult[] = [];
      let marker: string | undefined;
      do {
        const page = await client.send(
          new SimulatePrincipalPolicyCommand({
            PolicySourceArn: request.policySourceArn,
            ActionNames: request.actions,
            ResourceArns: [request.resourceArn],
            ContextEntries: request.context.map((entry) => ({
              ContextKeyName: entry.key,
              ContextKeyValues: entry.values,
              ContextKeyType: entry.type,
            })),
            Marker: marker,
          }),
        );
        results.push(...(page.EvaluationResults ?? []));
        marker = page.IsTruncated ? page.Marker : undefined;
      } while (marker);
      return results.map((result) => ({
        action: result.EvalActionName ?? '',
        resourceArn: result.EvalResourceName ?? request.resourceArn,
        decision: result.EvalDecision ?? 'implicitDeny',
      }));
    });
  }

  async ec2DryRun(
    credential: AwsCredential,
    request: Ec2DryRunRequest,
  ): Promise<AwsAnswer<true>> {
    const client = new EC2Client({
      region: request.region,
      credentials: credential,
    });
    const tagged = (type: ResourceType): TagSpecification[] => [
      {
        ResourceType: type,
        Tags: Object.entries(request.tags).map(([Key, Value]) => ({
          Key,
          Value,
        })),
      },
    ];
    const command = {
      CreateVpc: () =>
        new CreateVpcCommand({
          DryRun: true,
          CidrBlock: '10.0.0.0/16',
          TagSpecifications: tagged('vpc'),
        }),
      CreateSubnet: () =>
        new CreateSubnetCommand({
          DryRun: true,
          VpcId: request.vpcId,
          CidrBlock: '10.0.0.0/24',
          TagSpecifications: tagged('subnet'),
        }),
      CreateInternetGateway: () =>
        new CreateInternetGatewayCommand({
          DryRun: true,
          TagSpecifications: tagged('internet-gateway'),
        }),
      CreateRouteTable: () =>
        new CreateRouteTableCommand({
          DryRun: true,
          VpcId: request.vpcId,
          TagSpecifications: tagged('route-table'),
        }),
      CreateSecurityGroup: () =>
        new CreateSecurityGroupCommand({
          DryRun: true,
          VpcId: request.vpcId,
          GroupName: 'cloudgate-region-check',
          Description: 'Cloudgate region check (dry run)',
          TagSpecifications: tagged('security-group'),
        }),
    }[request.action]();
    try {
      await client.send(command);
    } catch (error) {
      if (error instanceof EC2ServiceException) {
        return error.name === 'DryRunOperation'
          ? { ok: true, value: true }
          : { ok: false, code: error.name, message: error.message };
      }
      throw error;
    }
    // A dry run that succeeded outright would have created something.
    throw new Error(`EC2 answered the ${request.action} dry run without one`);
  }

  countVpcs(
    credential: AwsCredential,
    region: string,
  ): Promise<AwsAnswer<number>> {
    return answer(async () => {
      const client = new EC2Client({ region, credentials: credential });
      let count = 0;
      let token: string | undefined;
      do {
        const page = await client.send(
          new DescribeVpcsCommand({ NextToken: token, MaxResults: 1000 }),
        );
        count += page.Vpcs?.length ?? 0;
        token = page.NextToken;
      } while (token);
      return count;
    });
  }

  ecrAuthorizationToken(
    session: AwsCredential,
    region: string,
  ): Promise<AwsAnswer<EcrLogin>> {
    return answer(async () => {
      const client = new ECRClient({ region, credentials: session });
      const found = await client.send(new GetAuthorizationTokenCommand({}));
      const data = found.authorizationData?.[0];
      if (!data?.authorizationToken || !data.proxyEndpoint) {
        throw new Error('ECR answered GetAuthorizationToken without a token');
      }
      // `AWS:<password>`, base64: the user is always `AWS`.
      const decoded = Buffer.from(data.authorizationToken, 'base64').toString(
        'utf8',
      );
      const colon = decoded.indexOf(':');
      return {
        registry: data.proxyEndpoint.replace(/^https?:\/\//, ''),
        username: decoded.slice(0, colon),
        password: decoded.slice(colon + 1),
      };
    });
  }

  ecrDeleteImagesExcept(
    session: AwsCredential,
    request: EcrCleanUpRequest,
  ): Promise<AwsAnswer<{ deleted: number }>> {
    return answer(async () => {
      const client = new ECRClient({
        region: request.region,
        credentials: session,
      });
      const images: ImageIdentifier[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListImagesCommand({
            repositoryName: request.repositoryName,
            nextToken: token,
          }),
        );
        images.push(...(page.imageIds ?? []));
        token = page.nextToken;
      } while (token);
      // An image may carry several tags; the live one is kept whole.
      const live = images.find(
        (image) => image.imageTag === request.keepTag,
      )?.imageDigest;
      const doomed = images.filter(
        (image) =>
          image.imageTag !== request.keepTag && image.imageDigest !== live,
      );
      let deleted = 0;
      for (let i = 0; i < doomed.length; i += 100) {
        const batch = await client.send(
          new BatchDeleteImageCommand({
            repositoryName: request.repositoryName,
            imageIds: doomed.slice(i, i + 100),
          }),
        );
        deleted += batch.imageIds?.length ?? 0;
      }
      return { deleted };
    });
  }

  ecsSetDesiredCount(
    session: AwsCredential,
    request: EcsServiceRef & { desiredCount: number },
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      await ecs(session, request.region).send(
        new UpdateServiceCommand({
          cluster: request.cluster,
          service: request.service,
          desiredCount: request.desiredCount,
        }),
      );
      return true as const;
    });
  }

  ecsForceNewDeployment(
    session: AwsCredential,
    request: EcsServiceRef,
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      await ecs(session, request.region).send(
        new UpdateServiceCommand({
          cluster: request.cluster,
          service: request.service,
          forceNewDeployment: true,
        }),
      );
      return true as const;
    });
  }

  rdsStopInstance(
    session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<RdsInstanceState>> {
    return answer(async () =>
      instanceState(
        (
          await rds(session, request.region).send(
            new StopDBInstanceCommand({
              DBInstanceIdentifier: request.identifier,
            }),
          )
        ).DBInstance,
      ),
    );
  }

  rdsStartInstance(
    session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<RdsInstanceState>> {
    return answer(async () =>
      instanceState(
        (
          await rds(session, request.region).send(
            new StartDBInstanceCommand({
              DBInstanceIdentifier: request.identifier,
            }),
          )
        ).DBInstance,
      ),
    );
  }

  ecsRollout(
    session: AwsCredential,
    request: EcsServiceRef,
  ): Promise<AwsAnswer<EcsRollout>> {
    return answer(async () => {
      const client = ecs(session, request.region);
      const found = await client.send(
        new DescribeServicesCommand({
          cluster: request.cluster,
          services: [request.service],
        }),
      );
      const primary = found.services?.[0]?.deployments?.find(
        (one) => one.status === 'PRIMARY',
      );
      if (!primary) {
        throw new Error(`ECS has no deployment of ${request.service}`);
      }
      const state =
        primary.rolloutState === 'COMPLETED'
          ? 'completed'
          : primary.rolloutState === 'FAILED'
            ? 'failed'
            : 'in-progress';
      const stoppedTask =
        (primary.failedTasks ?? 0) > 0 || state === 'failed'
          ? await this.lastStoppedTask(
              client,
              request,
              primary.taskDefinition ?? null,
            )
          : null;
      return {
        state,
        reason: primary.rolloutStateReason ?? null,
        stoppedTask,
      };
    });
  }

  /** The newest stopped task of the deployment's task definition. */
  private async lastStoppedTask(
    client: ECSClient,
    request: EcsServiceRef,
    taskDefinition: string | null,
  ): Promise<StoppedTask | null> {
    const listed = await client.send(
      new ListTasksCommand({
        cluster: request.cluster,
        serviceName: request.service,
        desiredStatus: 'STOPPED',
      }),
    );
    const arns = listed.taskArns ?? [];
    if (arns.length === 0) return null;
    const described = await client.send(
      new DescribeTasksCommand({
        cluster: request.cluster,
        tasks: arns.slice(0, 100),
      }),
    );
    const stopped = (described.tasks ?? [])
      .filter(
        (task) =>
          taskDefinition === null || task.taskDefinitionArn === taskDefinition,
      )
      .sort(
        (a, b) => (b.stoppedAt?.getTime() ?? 0) - (a.stoppedAt?.getTime() ?? 0),
      );
    const task = stopped[0];
    return task ? stoppedTaskOf(task) : null;
  }

  filterLogEvents(
    session: AwsCredential,
    request: LogEventsRequest,
  ): Promise<AwsAnswer<LogEvent[]>> {
    return answer(async () => {
      const client = new CloudWatchLogsClient({
        region: request.region,
        credentials: session,
      });
      const events: LogEvent[] = [];
      let token: string | undefined;
      // Oldest first, a page at a time; one task's stream of a failed start
      // is short, so a few pages hold all of it.
      for (let page = 0; page < 10; page++) {
        const found = await client.send(
          new FilterLogEventsCommand({
            logGroupName: request.logGroupName,
            logStreamNames: request.logStreamNames,
            nextToken: token,
          }),
        );
        for (const event of found.events ?? []) {
          events.push({
            timestamp: event.timestamp ?? 0,
            message: (event.message ?? '').replace(/\n$/, ''),
          });
        }
        token = found.nextToken;
        if (!token) break;
      }
      return events.slice(-request.limit);
    });
  }

  filterLogStreams(
    session: AwsCredential,
    request: LogStreamsRequest,
  ): Promise<AwsAnswer<LogStreamsPage>> {
    return answer(async () => {
      const client = new CloudWatchLogsClient({
        region: request.region,
        credentials: session,
      });
      const events: StreamLogEvent[] = [];
      let token: string | undefined;
      // Oldest first, a page at a time, until the limit is met; what is left
      // is read by the next poll, from the last event's time.
      for (let page = 0; page < 10; page++) {
        const found = await client.send(
          new FilterLogEventsCommand({
            logGroupName: request.logGroupName,
            logStreamNamePrefix: request.logStreamNamePrefix,
            startTime: request.startTime,
            limit: request.limit - events.length,
            nextToken: token,
          }),
        );
        for (const event of found.events ?? []) {
          events.push({
            eventId: event.eventId ?? '',
            logStreamName: event.logStreamName ?? '',
            timestamp: event.timestamp ?? 0,
            message: (event.message ?? '').replace(/\n$/, ''),
          });
        }
        token = found.nextToken;
        if (!token || events.length >= request.limit) break;
      }
      return {
        events: events.slice(0, request.limit),
        more: token !== undefined && events.length >= request.limit,
      };
    });
  }

  acmDescribeCertificate(
    session: AwsCredential,
    request: { region: string; certificateArn: string },
  ): Promise<AwsAnswer<AcmCertificate>> {
    return answer(async () => {
      const found = await new ACMClient({
        region: request.region,
        credentials: session,
      }).send(
        new DescribeCertificateCommand({
          CertificateArn: request.certificateArn,
        }),
      );
      const certificate = found.Certificate;
      const record = certificate?.DomainValidationOptions?.find(
        (option) => option.ResourceRecord,
      )?.ResourceRecord;
      return {
        status: certificate?.Status ?? 'FAILED',
        reason: certificate?.FailureReason ?? null,
        validationRecord:
          record?.Name && record.Type && record.Value
            ? { name: record.Name, type: record.Type, value: record.Value }
            : null,
      };
    });
  }

  async acmDeleteCertificate(
    session: AwsCredential,
    request: { region: string; certificateArn: string },
  ): Promise<AwsAnswer<AcmDeletion>> {
    const deleted = await answer(() =>
      new ACMClient({ region: request.region, credentials: session }).send(
        new DeleteCertificateCommand({
          CertificateArn: request.certificateArn,
        }),
      ),
    );
    if (deleted.ok) return { ok: true, value: 'deleted' };
    if (deleted.code === 'ResourceInUseException') {
      return { ok: true, value: 'in-use' };
    }
    if (deleted.code === 'ResourceNotFoundException') {
      return { ok: true, value: 'gone' };
    }
    return deleted;
  }

  /** Node's resolver on the platform host; a name with no answer is empty. */
  async dnsLookup(name: string): Promise<DnsAnswer> {
    const [cnames, addresses] = await Promise.all([
      dns.resolveCname(name).catch(() => [] as string[]),
      dns.resolve4(name).catch(() => [] as string[]),
    ]);
    return { cnames, addresses };
  }

  findTagged(
    session: AwsCredential,
    request: TagSearchRequest,
  ): Promise<AwsAnswer<TaggedResource[]>> {
    return answer(async () => {
      const client = new ResourceGroupsTaggingAPIClient({
        region: request.region,
        credentials: session,
      });
      const found: TaggedResource[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new GetResourcesCommand({
            TagFilters: Object.entries(request.tags).map(([Key, Value]) => ({
              Key,
              Values: [Value],
            })),
            PaginationToken: token || undefined,
          }),
        );
        for (const mapping of page.ResourceTagMappingList ?? []) {
          if (!mapping.ResourceARN) continue;
          found.push({
            arn: mapping.ResourceARN,
            tags: Object.fromEntries(
              (mapping.Tags ?? []).map((tag) => [
                tag.Key ?? '',
                tag.Value ?? '',
              ]),
            ),
          });
        }
        token = page.PaginationToken;
      } while (token);
      return found;
    });
  }

  findIamRole(
    session: AwsCredential,
    roleName: string,
  ): Promise<AwsAnswer<{ arn: string } | null>> {
    return answer(async () => {
      const client = new IAMClient({
        region: GLOBAL_REGION,
        credentials: session,
      });
      try {
        const found = await client.send(
          new GetRoleCommand({ RoleName: roleName }),
        );
        return found.Role?.Arn ? { arn: found.Role.Arn } : null;
      } catch (error) {
        // Gone is the answer a Delete hopes for, not a refusal.
        if (error instanceof NoSuchEntityException) return null;
        // IAM authorizes a GetRole of a role that is not there on
        // `role/<name>`, with no path, which the deploy role's
        // `role/cloudgate/cloudgate-*` never matches: AWS answers
        // AccessDenied, not NoSuchEntity. A Cloudgate role, which is
        // always on that path, would have been readable, so none is there.
        if (
          error instanceof IAMServiceException &&
          error.name === 'AccessDenied'
        ) {
          return null;
        }
        throw error;
      }
    });
  }

  ecsStanding(
    session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<EcsStanding>> {
    return answer(async () => {
      const client = ecs(session, request.region);
      const live: string[] = [];
      const inactiveTaskDefinitions: string[] = [];
      // `task/<cluster>/<id>` and `service/<cluster>/<name>`, asked per cluster.
      const byCluster = (kind: string) => {
        const groups = new Map<string, string[]>();
        for (const arn of request.arns) {
          const [type, cluster] = arn.split(':').slice(5).join(':').split('/');
          if (type !== kind || !cluster) continue;
          groups.set(cluster, [...(groups.get(cluster) ?? []), arn]);
        }
        return groups;
      };
      for (const [cluster, tasks] of byCluster('task')) {
        for (const part of chunks(tasks, 100)) {
          const found = await client.send(
            new DescribeTasksCommand({ cluster, tasks: part }),
          );
          for (const task of found.tasks ?? []) {
            if (task.taskArn && task.lastStatus !== 'STOPPED') {
              live.push(task.taskArn);
            }
          }
        }
      }
      for (const [cluster, services] of byCluster('service')) {
        for (const part of chunks(services, 10)) {
          const found = await client.send(
            new DescribeServicesCommand({ cluster, services: part }),
          );
          for (const service of found.services ?? []) {
            // DRAINING is a deleted service on its way out; its tasks are
            // asked about themselves.
            if (service.serviceArn && service.status === 'ACTIVE') {
              live.push(service.serviceArn);
            }
          }
        }
      }
      const clusters = request.arns.filter((arn) =>
        arn.split(':').slice(5).join(':').startsWith('cluster/'),
      );
      for (const part of chunks(clusters, 100)) {
        const found = await client.send(
          new DescribeClustersCommand({ clusters: part }),
        );
        for (const cluster of found.clusters ?? []) {
          if (cluster.clusterArn && cluster.status !== 'INACTIVE') {
            live.push(cluster.clusterArn);
          }
        }
      }
      for (const arn of request.arns) {
        const kind = arn.split(':').slice(5).join(':').split('/')[0];
        if (kind === 'task-definition') {
          try {
            const found = await client.send(
              new DescribeTaskDefinitionCommand({ taskDefinition: arn }),
            );
            const status = found.taskDefinition?.status;
            if (status === 'ACTIVE') live.push(arn);
            else if (status === 'INACTIVE') inactiveTaskDefinitions.push(arn);
          } catch (error) {
            // A deleted revision is unknown to ECS: gone.
            if (!(error instanceof ECSServiceException)) throw error;
            if (error.name !== 'ClientException') throw error;
          }
        } else if (!['task', 'service', 'cluster'].includes(kind ?? '')) {
          // Any other ECS resource is not one ECS can be asked about here.
          live.push(arn);
        }
      }
      return { live, inactiveTaskDefinitions };
    });
  }

  ec2Standing(
    session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<Ec2Standing>> {
    return answer(async () => {
      const client = new EC2Client({
        region: request.region,
        credentials: session,
      });
      const live = new Set<string>();
      // `subnet/subnet-0dd6…`: each type's ids, asked of its own Describe.
      const byType = new Map<string, Map<string, string>>();
      for (const arn of request.arns) {
        const [type = '', id] = arn.split(':').slice(5).join(':').split('/');
        if (!id || !EC2_DESCRIBES.has(type)) {
          // Not a type there is a Describe for here: unconfirmed, so left.
          live.add(arn);
          continue;
        }
        byType.set(
          type,
          (byType.get(type) ?? new Map<string, string>()).set(id, arn),
        );
      }
      for (const [type, ids] of byType) {
        const describe = EC2_DESCRIBES.get(type);
        if (!describe) continue;
        for (const part of chunks([...ids.keys()], 100)) {
          for (const id of await ec2Described(client, describe, part)) {
            const arn = ids.get(id);
            if (arn) live.add(arn);
          }
        }
      }
      return { live: request.arns.filter((arn) => live.has(arn)) };
    });
  }

  ecsDeleteTaskDefinitions(
    session: AwsCredential,
    request: { region: string; arns: readonly string[] },
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      const client = ecs(session, request.region);
      for (const part of chunks(request.arns, 10)) {
        const done = await client.send(
          new DeleteTaskDefinitionsCommand({ taskDefinitions: part }),
        );
        const failure = done.failures?.[0];
        if (failure) {
          throw new Error(
            `ECS did not delete ${failure.arn ?? 'a task definition'}: ${failure.reason ?? 'no reason given'}`,
          );
        }
      }
      return true as const;
    });
  }

  ecsRunTask(
    session: AwsCredential,
    request: EcsRunTaskRequest,
  ): Promise<AwsAnswer<EcsRunTaskOutcome>> {
    return answer(async (): Promise<EcsRunTaskOutcome> => {
      const ran = await ecs(session, request.region).send(
        new RunTaskCommand({
          cluster: request.cluster,
          taskDefinition: request.taskDefinitionArn,
          launchType: 'FARGATE',
          count: 1,
          startedBy: request.startedBy.slice(0, 128),
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: [...request.subnets],
              securityGroups: [...request.securityGroups],
              assignPublicIp: 'ENABLED',
            },
          },
          enableECSManagedTags: true,
          tags: Object.entries(request.tags).map(([key, value]) => ({
            key,
            value,
          })),
        }),
      );
      const task = ran.tasks?.[0];
      if (task?.taskArn) return { started: true, taskArn: task.taskArn };
      const failure = ran.failures?.[0];
      return {
        started: false,
        reason: failure
          ? [failure.reason, failure.detail].filter(Boolean).join(': ') ||
            'ECS gave no reason'
          : 'ECS started no task and gave no reason',
      };
    });
  }

  ecsDescribeTasks(
    session: AwsCredential,
    request: EcsTasksRef,
  ): Promise<AwsAnswer<EcsTaskState[]>> {
    return answer(async () => {
      if (request.taskArns.length === 0) return [];
      const described = await ecs(session, request.region).send(
        new DescribeTasksCommand({
          cluster: request.cluster,
          tasks: [...request.taskArns],
        }),
      );
      // A task ECS has forgotten is a `MISSING` failure: not in the answer.
      return (described.tasks ?? []).map((task) => {
        const container = task.containers?.[0];
        const stopped = task.lastStatus === 'STOPPED';
        return {
          taskArn: task.taskArn ?? '',
          lastStatus: task.lastStatus ?? 'UNKNOWN',
          exitCode: container?.exitCode ?? null,
          stoppedReason: stopped
            ? `${task.stoppedReason ?? 'ECS stopped the task'}${container?.reason ? ` (${container.reason})` : ''}`
            : null,
        };
      });
    });
  }

  ecsStopTask(
    session: AwsCredential,
    request: EcsStopTaskRequest,
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      try {
        await ecs(session, request.region).send(
          new StopTaskCommand({
            cluster: request.cluster,
            task: request.taskArn,
            reason: request.reason.slice(0, 255),
          }),
        );
      } catch (error) {
        // ECS's words for a task it no longer knows: gone all the same.
        if (
          error instanceof InvalidParameterException &&
          /task.*not found/i.test(error.message)
        ) {
          return true as const;
        }
        throw error;
      }
      return true as const;
    });
  }

  codeBuildStart(
    session: AwsCredential,
    request: CodeBuildStartRequest,
  ): Promise<AwsAnswer<{ buildId: string }>> {
    return answer(async () => {
      const started = await codeBuild(session, request.region).send(
        new StartBuildCommand({
          projectName: request.projectName,
          sourceTypeOverride: 'S3',
          sourceLocationOverride: request.sourceLocation,
          buildspecOverride: request.buildspec,
          idempotencyToken: request.idempotencyToken,
          // Only a parameter's name: CodeBuild reads the value as the
          // build identity.
          ...(request.parameterVariables?.length
            ? {
                environmentVariablesOverride: request.parameterVariables.map(
                  (variable) => ({
                    name: variable.name,
                    value: variable.parameterName,
                    type: 'PARAMETER_STORE' as const,
                  }),
                ),
              }
            : {}),
        }),
      );
      const buildId = started.build?.id;
      if (!buildId) throw new Error('CodeBuild started a build with no id');
      return { buildId };
    });
  }

  codeBuildState(
    session: AwsCredential,
    request: CodeBuildRef,
  ): Promise<AwsAnswer<CodeBuildState>> {
    return answer(async () => {
      const found = await codeBuild(session, request.region).send(
        new BatchGetBuildsCommand({ ids: [request.buildId] }),
      );
      const build = found.builds?.find((one) => one.id === request.buildId);
      if (!build) {
        // CodeBuild's answer for an id it does not know, as an answer.
        throw new CodeBuildServiceException({
          name: 'ResourceNotFoundException',
          $fault: 'client',
          $metadata: {},
          message: `CodeBuild has no build ${request.buildId}`,
        });
      }
      return codeBuildStateOf(build);
    });
  }

  codeBuildStop(
    session: AwsCredential,
    request: CodeBuildRef,
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      await codeBuild(session, request.region).send(
        new StopBuildCommand({ id: request.buildId }),
      );
      return true as const;
    });
  }

  putBuildParameter(
    session: AwsCredential,
    request: BuildParameterPut,
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      await new SSMClient({
        region: request.region,
        credentials: session,
      }).send(
        new PutParameterCommand({
          Name: request.name,
          Value: request.value,
          // Under SSM's AWS managed key, which the build identity decrypts
          // through SSM with no KMS grant of its own.
          Type: 'SecureString',
          Overwrite: false,
          Tags: [{ Key: CLOUD_ACCOUNT_TAG_KEY, Value: request.tagValue }],
        }),
      );
      return true as const;
    });
  }

  deleteParameter(
    session: AwsCredential,
    request: ParameterRef,
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      try {
        await new SSMClient({
          region: request.region,
          credentials: session,
        }).send(new DeleteParameterCommand({ Name: request.name }));
      } catch (error) {
        if (error instanceof ParameterNotFound) return true as const;
        throw error;
      }
      return true as const;
    });
  }

  ec2StopInstance(
    session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>> {
    return answer(async () => {
      const stopped = await new EC2Client({
        region: request.region,
        credentials: session,
      }).send(new StopInstancesCommand({ InstanceIds: [request.instanceId] }));
      return ec2State(stopped.StoppingInstances?.[0]?.CurrentState?.Name);
    });
  }

  ec2StartInstance(
    session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>> {
    return answer(async () => {
      const started = await new EC2Client({
        region: request.region,
        credentials: session,
      }).send(new StartInstancesCommand({ InstanceIds: [request.instanceId] }));
      return ec2State(started.StartingInstances?.[0]?.CurrentState?.Name);
    });
  }

  ec2InstanceState(
    session: AwsCredential,
    request: Ec2InstanceRef,
  ): Promise<AwsAnswer<Ec2InstanceState>> {
    return answer(async () => {
      const found = await new EC2Client({
        region: request.region,
        credentials: session,
      }).send(
        new DescribeInstancesCommand({ InstanceIds: [request.instanceId] }),
      );
      return ec2State(found.Reservations?.[0]?.Instances?.[0]?.State?.Name);
    });
  }

  startSshSession(
    session: AwsCredential,
    request: SshSessionRequest,
  ): Promise<AwsAnswer<SshSession>> {
    return answer(async () => {
      const started = await new SSMClient({
        region: request.region,
        credentials: session,
      }).send(
        new StartSessionCommand({
          Target: request.instanceId,
          DocumentName: SSH_SESSION_DOCUMENT,
          Parameters: { portNumber: ['22'] },
          Reason: 'Cloudgate: a Stack VM, reached over SSH',
        }),
      );
      if (!started.SessionId || !started.StreamUrl || !started.TokenValue) {
        throw new Error('SSM answered StartSession without a session');
      }
      return {
        sessionId: started.SessionId,
        streamUrl: started.StreamUrl,
        tokenValue: started.TokenValue,
      };
    });
  }

  terminateSession(
    session: AwsCredential,
    request: { region: string; sessionId: string },
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      await new SSMClient({
        region: request.region,
        credentials: session,
      }).send(new TerminateSessionCommand({ SessionId: request.sessionId }));
      return true as const;
    });
  }

  readLogStream(
    session: AwsCredential,
    request: LogStreamReadRequest,
  ): Promise<AwsAnswer<LogStreamRead>> {
    return answer(async () => {
      const client = new CloudWatchLogsClient({
        region: request.region,
        credentials: session,
      });
      const messages: string[] = [];
      let next = request.from;
      // A page at a time until CloudWatch hands back the token it was given,
      // which is how it says there is nothing newer.
      for (let page = 0; page < 10; page++) {
        let found: GetLogEventsCommandOutput;
        try {
          found = await client.send(
            new GetLogEventsCommand({
              logGroupName: request.logGroupName,
              logStreamName: request.logStreamName,
              startFromHead: true,
              ...(next ? { nextToken: next } : {}),
            }),
          );
        } catch (error) {
          // The stream is made by the task's first line: none yet is empty.
          if (error instanceof LogsResourceNotFound) {
            return { messages, next };
          }
          throw error;
        }
        for (const event of found.events ?? []) {
          messages.push((event.message ?? '').replace(/\n$/, ''));
        }
        // Only a page with events moves the read on: the token a read of a
        // stream with no events yet hands out never sees one added after
        // it, and a short Cron run read so before its first line logged none
        // of its output (found on the AWS acceptance walk).
        if ((found.events ?? []).length === 0) break;
        const token = found.nextForwardToken ?? next;
        if (token === next) break;
        next = token;
      }
      return { messages, next };
    });
  }

  networkInterfacesOf(
    session: AwsCredential,
    request: NetworkInterfacesRequest,
  ): Promise<AwsAnswer<NetworkInterface[]>> {
    return answer(async () => {
      if (request.securityGroupIds.length === 0) return [];
      const client = new EC2Client({
        region: request.region,
        credentials: session,
      });
      const found: NetworkInterface[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new DescribeNetworkInterfacesCommand({
            Filters: [{ Name: 'group-id', Values: request.securityGroupIds }],
            NextToken: token,
          }),
        );
        for (const card of page.NetworkInterfaces ?? []) {
          if (!card.NetworkInterfaceId) continue;
          found.push({
            networkInterfaceId: card.NetworkInterfaceId,
            securityGroupIds: (card.Groups ?? [])
              .map((group) => group.GroupId ?? '')
              .filter((id) => request.securityGroupIds.includes(id)),
            description: card.Description ?? '',
          });
        }
        token = page.NextToken;
      } while (token);
      return found;
    });
  }

  rdsBackups(
    session: AwsCredential,
    request: CloudDatabaseRef,
  ): Promise<AwsAnswer<RdsBackups>> {
    return answer(async () => {
      const client = new RDSClient({
        region: request.region,
        credentials: session,
      });
      const { DBInstances } = await client.send(
        new DescribeDBInstancesCommand({
          DBInstanceIdentifier: request.identifier,
        }),
      );
      const instance = DBInstances?.[0];
      if (!instance) {
        throw new Error(
          `RDS answered DescribeDBInstances without ${request.identifier}`,
        );
      }
      // An earlier instance of the same identifier may have left a retained
      // one: the live instance's is the one with its resource id.
      const { DBInstanceAutomatedBackups } = await client.send(
        new DescribeDBInstanceAutomatedBackupsCommand({
          DBInstanceIdentifier: request.identifier,
        }),
      );
      const automated = (DBInstanceAutomatedBackups ?? []).find(
        (one) => one.DbiResourceId === instance.DbiResourceId,
      );
      const snapshots: DatabaseSnapshot[] = [];
      let marker: string | undefined;
      for (let page = 0; page < SNAPSHOT_PAGES; page++) {
        const found = await client.send(
          new DescribeDBSnapshotsCommand({
            DBInstanceIdentifier: request.identifier,
            Marker: marker,
          }),
        );
        for (const snapshot of found.DBSnapshots ?? []) {
          if (!snapshot.DBSnapshotIdentifier) continue;
          snapshots.push({
            id: snapshot.DBSnapshotIdentifier,
            type:
              snapshot.SnapshotType === 'automated' ? 'automated' : 'manual',
            createdAt: isoOf(snapshot.SnapshotCreateTime),
            status: snapshot.Status ?? 'unknown',
            size:
              snapshot.AllocatedStorage === undefined
                ? null
                : `${snapshot.AllocatedStorage} GB`,
          });
        }
        marker = found.Marker;
        if (!marker) break;
      }
      return {
        retentionDays: instance.BackupRetentionPeriod ?? 0,
        earliestRestorableTime: isoOf(automated?.RestoreWindow?.EarliestTime),
        latestRestorableTime: isoOf(instance.LatestRestorableTime),
        snapshots: newestFirst(snapshots),
      };
    });
  }

  cacheBackups(
    session: AwsCredential,
    request: CloudDatabaseRef,
  ): Promise<AwsAnswer<CacheBackups>> {
    return answer(async () => {
      const client = new ElastiCacheClient({
        region: request.region,
        credentials: session,
      });
      const { ReplicationGroups } = await client.send(
        new DescribeReplicationGroupsCommand({
          ReplicationGroupId: request.identifier,
        }),
      );
      const group = ReplicationGroups?.[0];
      if (!group) {
        throw new Error(
          `ElastiCache answered DescribeReplicationGroups without ${request.identifier}`,
        );
      }
      const snapshots: DatabaseSnapshot[] = [];
      let marker: string | undefined;
      for (let page = 0; page < SNAPSHOT_PAGES; page++) {
        const found = await client.send(
          new DescribeSnapshotsCommand({
            ReplicationGroupId: request.identifier,
            Marker: marker,
          }),
        );
        for (const snapshot of found.Snapshots ?? []) {
          if (!snapshot.SnapshotName) continue;
          // One node is snapshotted (cluster mode is off): its time and size.
          const node = snapshot.NodeSnapshots?.[0];
          snapshots.push({
            id: snapshot.SnapshotName,
            type:
              snapshot.SnapshotSource === 'automated' ? 'automated' : 'manual',
            createdAt: isoOf(node?.SnapshotCreateTime),
            status: snapshot.SnapshotStatus ?? 'unknown',
            size: node?.CacheSize ?? null,
          });
        }
        marker = found.Marker;
        if (!marker) break;
      }
      return {
        retentionDays: group.SnapshotRetentionLimit ?? 0,
        snapshots: newestFirst(snapshots),
      };
    });
  }

  cloudFrontSwitchOrigin(
    session: AwsCredential,
    request: OriginSwitchRequest,
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      const client = cloudFront(session);
      const current = await client.send(
        new GetDistributionConfigCommand({ Id: request.distributionId }),
      );
      const config = current.DistributionConfig;
      const origin = config?.Origins?.Items?.find(
        (one) => one.Id === request.originId,
      );
      if (!config || !origin) {
        throw new CloudFrontServiceException({
          name: 'NoSuchOrigin',
          $fault: 'client',
          $metadata: {},
          message: `The distribution has no origin ${request.originId}`,
        });
      }
      origin.OriginPath = request.originPath;
      await client.send(
        new UpdateDistributionCommand({
          Id: request.distributionId,
          IfMatch: current.ETag,
          DistributionConfig: config,
        }),
      );
      return true as const;
    });
  }

  cloudFrontCreateInvalidation(
    session: AwsCredential,
    request: InvalidationRequest,
  ): Promise<AwsAnswer<{ invalidationId: string }>> {
    return answer(async () => {
      const made = await cloudFront(session).send(
        new CreateInvalidationCommand({
          DistributionId: request.distributionId,
          InvalidationBatch: {
            CallerReference: request.callerReference,
            Paths: { Quantity: request.paths.length, Items: request.paths },
          },
        }),
      );
      return { invalidationId: made.Invalidation?.Id ?? '' };
    });
  }

  cloudFrontDistributionStatus(
    session: AwsCredential,
    distributionId: string,
  ): Promise<AwsAnswer<DistributionStatus>> {
    return answer(async () => {
      const found = await cloudFront(session).send(
        new GetDistributionCommand({ Id: distributionId }),
      );
      return found.Distribution?.Status === 'Deployed'
        ? 'Deployed'
        : 'InProgress';
    });
  }

  cloudFrontInvalidationStatus(
    session: AwsCredential,
    request: { distributionId: string; invalidationId: string },
  ): Promise<AwsAnswer<InvalidationStatus>> {
    return answer(async () => {
      const found = await cloudFront(session).send(
        new GetInvalidationCommand({
          DistributionId: request.distributionId,
          Id: request.invalidationId,
        }),
      );
      return found.Invalidation?.Status === 'Completed'
        ? 'Completed'
        : 'InProgress';
    });
  }

  rdsLiftDeletionProtection(
    session: AwsCredential,
    request: RdsInstanceRef,
  ): Promise<AwsAnswer<DeletionProtectionLift>> {
    return answer(async () => {
      // Asked first because the deploy role may modify only an instance
      // carrying its tag: on a gone one — a Retry after a destroy that went
      // through — ModifyDBInstance answers AccessDenied, never
      // DBInstanceNotFound. Describing is granted on every instance.
      let found: DBInstance | undefined;
      try {
        const described = await rds(session, request.region).send(
          new DescribeDBInstancesCommand({
            DBInstanceIdentifier: request.identifier,
          }),
        );
        found = described.DBInstances?.[0];
      } catch (error) {
        if (error instanceof DBInstanceNotFoundFault) {
          return 'no-instance' as const;
        }
        throw error;
      }
      if (found?.DeletionProtection === false) return 'lifted' as const;
      try {
        await rds(session, request.region).send(
          new ModifyDBInstanceCommand({
            DBInstanceIdentifier: request.identifier,
            DeletionProtection: false,
            ApplyImmediately: true,
          }),
        );
        return 'lifted' as const;
      } catch (error) {
        // No instance is nothing to protect, not a refusal.
        if (error instanceof DBInstanceNotFoundFault) {
          return 'no-instance' as const;
        }
        throw error;
      }
    });
  }

  rdsSnapshot(
    session: AwsCredential,
    request: SnapshotRef,
  ): Promise<AwsAnswer<FinalSnapshot | null>> {
    return answer(async () => {
      try {
        const found = await rds(session, request.region).send(
          new DescribeDBSnapshotsCommand({
            DBSnapshotIdentifier: request.name,
          }),
        );
        const snapshot = found.DBSnapshots?.[0];
        if (!snapshot?.DBSnapshotArn) return null;
        return {
          arn: snapshot.DBSnapshotArn,
          sizeGb: snapshot.AllocatedStorage ?? 0,
        };
      } catch (error) {
        if (error instanceof DBSnapshotNotFoundFault) return null;
        throw error;
      }
    });
  }

  elastiCacheSnapshot(
    session: AwsCredential,
    request: SnapshotRef,
  ): Promise<AwsAnswer<FinalSnapshot | null>> {
    return answer(async () => {
      try {
        const found = await new ElastiCacheClient({
          region: request.region,
          credentials: session,
        }).send(new DescribeSnapshotsCommand({ SnapshotName: request.name }));
        const snapshot = found.Snapshots?.[0];
        if (!snapshot?.ARN) return null;
        return {
          arn: snapshot.ARN,
          sizeGb: (snapshot.NodeSnapshots ?? []).reduce(
            (sum, node) => sum + cacheSizeGib(node.CacheSize),
            0,
          ),
        };
      } catch (error) {
        if (error instanceof SnapshotNotFoundFault) return null;
        throw error;
      }
    });
  }

  ec2TakeSnapshot(
    session: AwsCredential,
    request: VolumeSnapshotRequest,
  ): Promise<AwsAnswer<VolumeSnapshot | null>> {
    return answer(() =>
      takeVolumeSnapshot(
        new EC2Client({ region: request.region, credentials: session }),
        request,
      ),
    );
  }

  ec2Snapshot(
    session: AwsCredential,
    request: { readonly region: string; readonly snapshotId: string },
  ): Promise<AwsAnswer<VolumeSnapshot | null>> {
    return answer(() =>
      volumeSnapshot(
        new EC2Client({ region: request.region, credentials: session }),
        request.snapshotId,
      ),
    );
  }

  ec2DailySnapshots(
    session: AwsCredential,
    request: { readonly region: string; readonly volumeId: string },
  ): Promise<AwsAnswer<string[]>> {
    return answer(() =>
      dailySnapshotsOf(
        new EC2Client({ region: request.region, credentials: session }),
        request.volumeId,
      ),
    );
  }

  ec2DeleteSnapshot(
    session: AwsCredential,
    request: { readonly region: string; readonly snapshotId: string },
  ): Promise<AwsAnswer<true>> {
    return answer(async () => {
      await deleteVolumeSnapshot(
        new EC2Client({ region: request.region, credentials: session }),
        request.snapshotId,
      );
      return true as const;
    });
  }
}

/** At most this many pages of snapshots: 100 each on RDS, 50 on ElastiCache. */
const SNAPSHOT_PAGES = 20;

function isoOf(time: Date | undefined): string | null {
  return time ? time.toISOString() : null;
}

/** Newest first; one AWS has not dated yet (still being taken) leads. */
function newestFirst(snapshots: DatabaseSnapshot[]): DatabaseSnapshot[] {
  return [...snapshots].sort((a, b) =>
    (b.createdAt ?? '￿').localeCompare(a.createdAt ?? '￿'),
  );
}

/**
 * ElastiCache's `CacheSize` (`"6 MB"`, `"1.2 GB"`) in GiB, as its snapshot
 * storage is billed; `0` for a size it does not state.
 */
export function cacheSizeGib(cacheSize: string | undefined): number {
  const found = /^\s*([\d.]+)\s*([KMGT]?B)\s*$/i.exec(cacheSize ?? '');
  if (!found) return 0;
  const power = ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(found[2].toUpperCase());
  return (Number(found[1]) * 1024 ** power) / 1024 ** 3;
}

function rds(session: AwsCredential, region: string): RDSClient {
  return new RDSClient({ region, credentials: session });
}

/** The instance's status as a Stop or Start left it; RDS always names it. */
function instanceState(instance: DBInstance | undefined): RdsInstanceState {
  return { status: instance?.DBInstanceStatus ?? 'unknown' };
}

/** EC2's state of an instance, which every answer about one names. */
function ec2State(name: InstanceStateName | undefined): Ec2InstanceState {
  if (!name) throw new Error("EC2 answered without the instance's state");
  return name;
}

/** CloudFront is global; its API answers in `us-east-1`. */
function cloudFront(session: AwsCredential): CloudFrontClient {
  return new CloudFrontClient({ region: GLOBAL_REGION, credentials: session });
}

/** `items` in runs of at most `size`, as AWS's batch calls take them. */
function chunks<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    runs.push(items.slice(i, i + size));
  }
  return runs;
}

type Ec2Describe = (
  client: EC2Client,
  ids: string[],
) => Promise<(string | undefined)[]>;

/**
 * The Describe by id of each EC2 type Cloudgate's definitions make,
 * as the ARN names it: what {@link AwsCloudAdapter.ec2Standing} can confirm.
 * Each is granted by name in the deploy role's ReadAnywhere statement.
 */
const EC2_DESCRIBES = new Map<string, Ec2Describe>([
  [
    'vpc',
    async (client, ids) =>
      (
        (await client.send(new DescribeVpcsCommand({ VpcIds: ids }))).Vpcs ?? []
      ).map((one) => one.VpcId),
  ],
  [
    'subnet',
    async (client, ids) =>
      (
        (await client.send(new DescribeSubnetsCommand({ SubnetIds: ids })))
          .Subnets ?? []
      ).map((one) => one.SubnetId),
  ],
  [
    'security-group',
    async (client, ids) =>
      (
        (
          await client.send(
            new DescribeSecurityGroupsCommand({ GroupIds: ids }),
          )
        ).SecurityGroups ?? []
      ).map((one) => one.GroupId),
  ],
  [
    'route-table',
    async (client, ids) =>
      (
        (
          await client.send(
            new DescribeRouteTablesCommand({ RouteTableIds: ids }),
          )
        ).RouteTables ?? []
      ).map((one) => one.RouteTableId),
  ],
  [
    'internet-gateway',
    async (client, ids) =>
      (
        (
          await client.send(
            new DescribeInternetGatewaysCommand({ InternetGatewayIds: ids }),
          )
        ).InternetGateways ?? []
      ).map((one) => one.InternetGatewayId),
  ],
]);

/**
 * The ids EC2 describes, of those asked. One it does not have fails the
 * whole Describe with `Invalid…ID.NotFound` (`InvalidGroup.NotFound` for a
 * security group), naming the id only in prose, so a batch that fails so
 * is asked again one id at a time.
 */
async function ec2Described(
  client: EC2Client,
  describe: Ec2Describe,
  ids: string[],
): Promise<string[]> {
  try {
    return (await describe(client, ids)).filter(
      (id): id is string => id !== undefined,
    );
  } catch (error) {
    if (
      !(error instanceof EC2ServiceException) ||
      !error.name.endsWith('.NotFound')
    ) {
      throw error;
    }
    if (ids.length === 1) return [];
    const found: string[] = [];
    for (const id of ids) {
      found.push(...(await ec2Described(client, describe, [id])));
    }
    return found;
  }
}

function codeBuild(session: AwsCredential, region: string): CodeBuildClient {
  return new CodeBuildClient({ region, credentials: session });
}

/** CodeBuild's phases before a build has capacity: the queue wait. */
const CODEBUILD_QUEUED_PHASES = new Set(['SUBMITTED', 'QUEUED']);

/** A build as {@link AwsCloudPort.codeBuildState} answers it. */
function codeBuildStateOf(build: Build): CodeBuildState {
  const ended = build.buildComplete === true;
  const failed = [...(build.phases ?? [])]
    .reverse()
    .find(
      (phase) =>
        phase.phaseStatus !== undefined &&
        phase.phaseStatus !== 'SUCCEEDED' &&
        phase.phaseStatus !== 'IN_PROGRESS',
    );
  const reason =
    failed?.contexts
      ?.map((context) =>
        [context.statusCode, context.message].filter(Boolean).join(': '),
      )
      .filter(Boolean)
      .join('; ') || null;
  const status = build.buildStatus ?? 'IN_PROGRESS';
  return {
    phase: ended
      ? 'ended'
      : CODEBUILD_QUEUED_PHASES.has(build.currentPhase ?? 'SUBMITTED')
        ? 'queued'
        : 'running',
    status: ended ? status : 'IN_PROGRESS',
    reason,
    logStreamName: build.logs?.streamName ?? null,
    exportedVariables: Object.fromEntries(
      (build.exportedEnvironmentVariables ?? []).map((variable) => [
        variable.name ?? '',
        variable.value ?? '',
      ]),
    ),
  };
}

function ecs(session: AwsCredential, region: string): ECSClient {
  return new ECSClient({ region, credentials: session });
}

/** A stopped task as the Deployment log quotes it: ECS's words, then its container's exit. */
function stoppedTaskOf(task: Task): StoppedTask {
  const container = task.containers?.find(
    (one) => one.exitCode !== undefined || one.reason,
  );
  const exit =
    container?.exitCode !== undefined
      ? ` (its container exited with code ${container.exitCode})`
      : container?.reason
        ? ` (${container.reason})`
        : '';
  return {
    taskId: (task.taskArn ?? '').split('/').pop() ?? '',
    stoppedReason: `${task.stoppedReason ?? 'ECS stopped the task'}${exit}`,
  };
}

function sts(credential: AwsCredential): STSClient {
  return new STSClient({ region: GLOBAL_REGION, credentials: credential });
}

/**
 * AWS's refusal as an answer; anything else — no network, a malformed reply —
 * still throws, because it is not something AWS said (the port's contract).
 */
async function answer<T>(call: () => Promise<T>): Promise<AwsAnswer<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (
      error instanceof STSServiceException ||
      error instanceof IAMServiceException ||
      error instanceof EC2ServiceException ||
      error instanceof ECRServiceException ||
      error instanceof ECSServiceException ||
      error instanceof RDSServiceException ||
      error instanceof ACMServiceException ||
      error instanceof CloudWatchLogsServiceException ||
      error instanceof CodeBuildServiceException ||
      error instanceof SSMServiceException ||
      error instanceof ResourceGroupsTaggingAPIServiceException ||
      error instanceof ElastiCacheServiceException ||
      error instanceof CloudFrontServiceException
    ) {
      return { ok: false, code: error.name, message: error.message };
    }
    throw error;
  }
}

// ── A Stack VM data disk's snapshots on EC2 (#1367): the direct calls its
// Delete makes besides `tofu destroy`, which knows neither the final
// snapshot it keeps nor the daily snapshots Data Lifecycle Manager took
// outside any state. Each takes the client, so the adapter calls them with
// the deploy role's session and the moto lane with moto's.

/** The tag Data Lifecycle Manager puts on every snapshot a policy takes. */
export const DLM_POLICY_TAG = 'aws:dlm:lifecycle-policy-id';

/** How Data Lifecycle Manager describes a snapshot it took. */
const DLM_DESCRIPTION = 'Created for policy:';

/**
 * `ec2:CreateSnapshot` of the volume, tagged at creation with its `Name`
 * and Cloudgate's tags: answers once EBS has started it, which fixes its
 * point in time. `null` when EC2 has no such volume.
 */
export async function takeVolumeSnapshot(
  client: EC2Client,
  request: {
    readonly volumeId: string;
    readonly name: string;
    readonly description: string;
    readonly tags: Readonly<Record<string, string>>;
  },
): Promise<VolumeSnapshot | null> {
  try {
    const made = await client.send(
      new CreateSnapshotCommand({
        VolumeId: request.volumeId,
        Description: request.description,
        TagSpecifications: [
          {
            ResourceType: 'snapshot',
            Tags: Object.entries({ Name: request.name, ...request.tags }).map(
              ([Key, Value]) => ({ Key, Value }),
            ),
          },
        ],
      }),
    );
    return {
      snapshotId: made.SnapshotId ?? '',
      state: stateOf(made.State),
      sizeGb: made.VolumeSize ?? 0,
    };
  } catch (error) {
    if (isNotFound(error, 'InvalidVolume.NotFound')) return null;
    throw error;
  }
}

/** `ec2:DescribeSnapshots` of one snapshot, or `null` when EC2 has none. */
export async function volumeSnapshot(
  client: EC2Client,
  snapshotId: string,
): Promise<VolumeSnapshot | null> {
  try {
    const found = await client.send(
      new DescribeEc2SnapshotsCommand({ SnapshotIds: [snapshotId] }),
    );
    const snapshot = found.Snapshots?.[0];
    if (!snapshot?.SnapshotId) return null;
    return {
      snapshotId: snapshot.SnapshotId,
      state: stateOf(snapshot.State),
      sizeGb: snapshot.VolumeSize ?? 0,
    };
  } catch (error) {
    if (isNotFound(error, 'InvalidSnapshot.NotFound')) return null;
    throw error;
  }
}

/**
 * The account's own snapshots of the volume that Data Lifecycle Manager
 * took: by its policy's tag, or, where a snapshot carries no tags, by how
 * it describes them. A snapshot anyone took by hand is never one of them,
 * so a Delete leaves it.
 */
export async function dailySnapshotsOf(
  client: EC2Client,
  volumeId: string,
): Promise<string[]> {
  const found: string[] = [];
  let token: string | undefined;
  do {
    const page = await client.send(
      new DescribeEc2SnapshotsCommand({
        OwnerIds: ['self'],
        Filters: [{ Name: 'volume-id', Values: [volumeId] }],
        NextToken: token,
      }),
    );
    for (const snapshot of page.Snapshots ?? []) {
      if (!snapshot.SnapshotId) continue;
      const daily =
        (snapshot.Tags ?? []).some((tag) => tag.Key === DLM_POLICY_TAG) ||
        (snapshot.Description ?? '').startsWith(DLM_DESCRIPTION);
      if (daily) found.push(snapshot.SnapshotId);
    }
    token = page.NextToken;
  } while (token);
  return found;
}

/** `ec2:DeleteSnapshot`; one EC2 no longer has is gone already. */
export async function deleteVolumeSnapshot(
  client: EC2Client,
  snapshotId: string,
): Promise<void> {
  try {
    await client.send(new DeleteSnapshotCommand({ SnapshotId: snapshotId }));
  } catch (error) {
    if (isNotFound(error, 'InvalidSnapshot.NotFound')) return;
    throw error;
  }
}

function stateOf(state: string | undefined): VolumeSnapshot['state'] {
  return state === 'completed' || state === 'error' ? state : 'pending';
}

function isNotFound(error: unknown, code: string): boolean {
  return (
    error instanceof EC2ServiceException &&
    (error.name === code || (error as { Code?: string }).Code === code)
  );
}
