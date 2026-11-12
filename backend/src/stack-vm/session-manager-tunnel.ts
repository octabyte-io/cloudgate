import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';

import { Inject, Injectable, Logger } from '@nestjs/common';

import { CloudAccountsService } from '../cloud-accounts/cloud-accounts.service';
import {
  AWS_CLOUD_PORT,
  SSH_SESSION_DOCUMENT,
} from '../cloud-accounts/cloud.port';
import type { AwsCloudPort } from '../cloud-accounts/cloud.port';
import { describeError } from '../common/describe-error';
import type { StackVmEndpointOn } from '../remote/stack-vm-remote';

/**
 * The Session Manager plugin the platform host's image and install carry
 * (`Dockerfile`, `deploy/install.sh`, pinned there), found on `PATH` unless
 * `SESSION_MANAGER_PLUGIN` names it.
 */
export function sessionManagerPlugin(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return env.SESSION_MANAGER_PLUGIN?.trim() || 'session-manager-plugin';
}

/**
 * The variable the plugin reads `StartSession`'s answer from, rather than
 * from its own argv, where `ps` would show the session's token.
 */
const START_SESSION_RESPONSE = 'AWS_SSM_START_SESSION_RESPONSE';

/**
 * **A Stack VM's tunnel on AWS** (ADR-0070): a Session Manager session to the
 * instance with the SSH document (`AWS-StartSSHSession`, port 22), its bytes
 * carried by the Session Manager plugin's stdin and stdout, as `ssh` carries
 * them with the plugin as its `ProxyCommand`.
 *
 * The session is started by Cloudgate's deploy role in the stack's Cloud
 * account, through the AWS port, so it is in that account's CloudTrail.
 * Ending the stream kills the plugin and ends the session.
 */
@Injectable()
export class SessionManagerTunnel {
  private readonly logger = new Logger(SessionManagerTunnel.name);

  constructor(
    private readonly cloudAccounts: CloudAccountsService,
    @Inject(AWS_CLOUD_PORT) private readonly aws: AwsCloudPort,
  ) {}

  async open(endpoint: StackVmEndpointOn<'aws'>): Promise<Duplex> {
    const { account, region, instanceId } = endpoint;
    const role = await this.cloudAccounts.deployRoleSession(account);
    if (!role.ok) throw new Error(role.refusal);
    const started = await this.aws.startSshSession(role.session, {
      region,
      instanceId,
    });
    if (!started.ok) {
      throw new Error(
        `AWS refused a Session Manager session to the Stack VM: ${started.message}`,
      );
    }
    const { sessionId, streamUrl, tokenValue } = started.value;
    const plugin = spawn(
      sessionManagerPlugin(),
      [
        START_SESSION_RESPONSE,
        region,
        'StartSession',
        '',
        JSON.stringify({
          Target: instanceId,
          DocumentName: SSH_SESSION_DOCUMENT,
          Parameters: { portNumber: ['22'] },
        }),
        `https://ssm.${region}.amazonaws.com`,
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          [START_SESSION_RESPONSE]: JSON.stringify({
            SessionId: sessionId,
            StreamUrl: streamUrl,
            TokenValue: tokenValue,
          }),
        },
      },
    );
    const tunnel = Duplex.from({
      readable: plugin.stdout,
      writable: plugin.stdin,
    });
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      if (plugin.exitCode === null) plugin.kill('SIGTERM');
      void this.aws
        .terminateSession(role.session, { region, sessionId })
        .catch((error: unknown) =>
          this.logger.warn(
            `Session ${sessionId} to ${instanceId} did not end: ${describeError(error)}`,
          ),
        );
    };
    tunnel.once('close', end);
    // Ending the stream from either side ends the plugin's pipes under it,
    // which `Duplex.from` reports as an abort: the session is over, and SSH
    // above has already said how its connection ended.
    tunnel.on('error', (error) =>
      this.logger.debug(`Session ${sessionId} ended: ${error.message}`),
    );
    plugin.stderr.on('data', (chunk: Buffer) =>
      this.logger.debug(`Session ${sessionId}: ${chunk.toString().trim()}`),
    );
    plugin.once('exit', () => tunnel.destroy());
    return new Promise((resolve, reject) => {
      plugin.once('spawn', () => resolve(tunnel));
      plugin.once('error', (error) => {
        end();
        reject(
          new Error(
            `The Session Manager plugin could not be started: ${error.message}`,
          ),
        );
      });
    });
  }
}
