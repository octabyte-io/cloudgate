import { ConfigService } from '@nestjs/config';
import {
  InvalidDBInstanceStateFault,
  RDSClient,
  StartDBInstanceCommand,
  StopDBInstanceCommand,
} from '@aws-sdk/client-rds';

import { AwsCloudAdapter } from '../../../src/cloud-accounts/aws/aws-cloud.adapter';
import type { AwsCredential } from '../../../src/cloud-accounts/cloud.port';

/**
 * The adapter's RDS Stop and Start, against what RDS answers: each
 * response below is `StopDBInstance`'s and `StartDBInstance`'s recorded
 * shape (the instance as the call left it, trimmed to what the call reads
 * and a few fields around it), and the refusal is RDS's own for an instance
 * not `available`.
 */

const SESSION: AwsCredential = {
  accessKeyId: 'ASIAEXAMPLE',
  secretAccessKey: 'secret',
  sessionToken: 'session-token',
};
const REF = { region: 'eu-central-1', identifier: 'cloudgate-pg1abc' };

/** `StopDBInstance`'s answer, as RDS sent it. */
const STOPPED = {
  $metadata: {
    httpStatusCode: 200,
    requestId: '5c5f0d36-6f7e-4d3c-a1b2-1d2c3b4a5e6f',
    attempts: 1,
    totalRetryDelay: 0,
  },
  DBInstance: {
    DBInstanceIdentifier: 'cloudgate-pg1abc',
    DBInstanceClass: 'db.t4g.micro',
    Engine: 'postgres',
    DBInstanceStatus: 'stopping',
    MasterUsername: 'app',
    DBName: 'app',
    Endpoint: {
      Address: 'cloudgate-pg1abc.c9akciq32.eu-central-1.rds.amazonaws.com',
      Port: 5432,
      HostedZoneId: 'Z1RLNUO7B9Q6NB',
    },
    AllocatedStorage: 20,
    InstanceCreateTime: new Date('2026-10-01T09:12:44.315Z'),
    MultiAZ: false,
    EngineVersion: '17.2',
    PubliclyAccessible: false,
    StorageType: 'gp3',
    DbiResourceId: 'db-ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    DeletionProtection: true,
  },
};

/** `StartDBInstance`'s answer, as RDS sent it. */
const STARTED = {
  ...STOPPED,
  DBInstance: { ...STOPPED.DBInstance, DBInstanceStatus: 'starting' },
};

describe('AwsCloudAdapter RDS Stop and Start', () => {
  let adapter: AwsCloudAdapter;
  let send: jest.SpyInstance<Promise<unknown>, [unknown]>;

  beforeEach(() => {
    adapter = new AwsCloudAdapter({
      get: () => '',
    } as unknown as ConfigService<never, true>);
    send = jest.spyOn(
      RDSClient.prototype,
      'send',
    ) as unknown as jest.SpyInstance<Promise<unknown>, [unknown]>;
  });

  afterEach(() => send.mockRestore());

  it('stops the instance by its identifier and answers the status RDS left it in', async () => {
    send.mockResolvedValueOnce(STOPPED);

    const answer = await adapter.rdsStopInstance(SESSION, REF);

    expect(answer).toEqual({ ok: true, value: { status: 'stopping' } });
    const command = send.mock.calls[0][0] as StopDBInstanceCommand;
    expect(command).toBeInstanceOf(StopDBInstanceCommand);
    expect(command.input).toEqual({ DBInstanceIdentifier: 'cloudgate-pg1abc' });
    const client = send.mock.contexts[0] as RDSClient;
    expect(await client.config.region()).toBe('eu-central-1');
  });

  it('starts the instance by its identifier and answers the status RDS left it in', async () => {
    send.mockResolvedValueOnce(STARTED);

    const answer = await adapter.rdsStartInstance(SESSION, REF);

    expect(answer).toEqual({ ok: true, value: { status: 'starting' } });
    const command = send.mock.calls[0][0] as StartDBInstanceCommand;
    expect(command).toBeInstanceOf(StartDBInstanceCommand);
    expect(command.input).toEqual({ DBInstanceIdentifier: 'cloudgate-pg1abc' });
  });

  it("answers RDS's refusal in its own words, never an exception", async () => {
    send.mockRejectedValueOnce(
      new InvalidDBInstanceStateFault({
        message: 'Instance cloudgate-pg1abc is not in available state.',
        $metadata: { httpStatusCode: 400 },
      }),
    );

    const answer = await adapter.rdsStopInstance(SESSION, REF);

    expect(answer).toEqual({
      ok: false,
      code: 'InvalidDBInstanceStateFault',
      message: 'Instance cloudgate-pg1abc is not in available state.',
    });
  });

  it('throws when RDS never answered: no network is not a refusal', async () => {
    send.mockRejectedValueOnce(new Error('connect ETIMEDOUT rds:443'));

    await expect(adapter.rdsStartInstance(SESSION, REF)).rejects.toThrow(
      'ETIMEDOUT',
    );
  });
});
