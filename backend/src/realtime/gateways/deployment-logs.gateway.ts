import type { IncomingMessage } from 'node:http';
import { Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { DeploymentsService } from '../../deployments/deployments.service';
import { isPastLogRetention } from '../../deployments/log-retention';
import { encodeBase64 } from '../../docker/docker.utils';
import { SshChannelService } from '../channels/ssh-channel.service';
import { LocalProcessChannelService } from '../channels/local-process-channel.service';
import {
  armAuthorizationLease,
  armKeepAlive,
  callerOf,
  denyConnection,
  journalDetailOf,
  LEASE_RENEWAL_INTERVAL,
  permissionCtxOrDeny,
  REAPED_LOG_CLOSE_CODE,
  reapedLogCloseReason,
  sendIfOpen,
} from '../socket-access';
import { WsAuthGuard } from '../ws-auth.guard';
import type { WsClient } from '../ws-client';
import { readValidDirectory } from '../ws.utils';

/**
 * The /listen-deployment socket: stream a deployment log file —
 * `tail -n +1 -f` replays everything written so far, then follows new lines
 * — locally or on the build server over SSH.
 *
 * **Addressed by `deploymentId`, not by path (ADR-0007).** A caller-supplied
 * `logPath` authorized by containment alone makes every file under the
 * platform directory — `ssh/` included — readable by any authenticated caller.
 * A deployment id inverts that: the only readable
 * file is one a deployment row points at, and that row carries the ownership
 * chain the entitlement check runs against. `logPath` and `serverId` are no
 * longer read off the URL at all.
 *
 * **Two readers of one artifact, and they ask one question.**
 * ADR-0020 keeps a deployment log for `DEPLOYMENT_LOG_RETENTION_DAYS` and made
 * `GET /deployments/:id/logs` answer a sentence naming the window past it. This
 * socket followed the same `logPath` and said nothing at all, so the same
 * Deployment read two ways disagreed about whether its log's absence was
 * explicable. It now answers the same sentence, on a close rather than in the
 * stream — {@link REAPED_LOG_CLOSE_CODE} carries why a frame was rejected — and
 * it reuses `isPastLogRetention` and `reapedLogNotice` rather than restating
 * either, because a second copy of the window rule is the failure ADR-0020
 * exists to avoid.
 *
 * **That agreement was made in two halves.** Reusing
 * the *notice* was never the hard part; the predicates were what had to match.
 * `DeploymentsService.readLogs` asks absence **and** age, this asked age alone,
 * and the paragraph above was true of an unreachable log and false of a
 * reachable one — past the window with the file still present, HTTP streamed
 * the log and this closed `4013` claiming it had been reaped. The close now
 * confirms the file is gone (`DeploymentsService.logFileIsAbsent`), which is
 * the same question by the same transport on the same machine, and the
 * sentence above stops being a claim only one of the two readers was keeping.
 */
@WebSocketGateway({ path: '/listen-deployment' })
export class DeploymentLogsGateway implements OnGatewayConnection {
  private readonly logger = new Logger(DeploymentLogsGateway.name);

  constructor(
    private readonly wsAuth: WsAuthGuard,
    private readonly deployments: DeploymentsService,
    private readonly sshChannels: SshChannelService,
    private readonly localProcesses: LocalProcessChannelService,
    @Inject(LEASE_RENEWAL_INTERVAL)
    private readonly leaseRenewalIntervalMs: number,
  ) {}

  async handleConnection(ws: WsClient, req: IncomingMessage) {
    // Authenticate before reading a single query parameter. An anonymous caller
    // gets one bare close whatever the URL said — a real deployment id, a bogus
    // one and none at all are indistinguishable — so nothing here answers about
    // the gateway's contract or about which ids exist until there is a caller
    // to answer. Validating first, which is still the other gateways' order,
    // made the 4000 below readable without a session.
    const auth = await this.wsAuth.authenticate(ws, req);
    if (!auth) return;

    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const deploymentId = url.searchParams.get('deploymentId');

    if (!deploymentId) {
      ws.close(4000, 'deploymentId not provided');
      return;
    }

    // Authorization after the parameter, not before it: a caller whose session
    // carries no active organization has a malformed request as well as an
    // unusable one, and 4000 says which without telling them anything they did
    // not already know about their own session.
    const ctx = permissionCtxOrDeny(ws, this.logger, auth);
    if (!ctx) return;

    // The whole authorization, in one place, because it is run twice: once here
    // and then on a clock for as long as the socket is open (ADR-0012). Every
    // input it reads is a database row that can change under a stream that
    // `tail -n +1 -f` will follow forever — a finished deployment's log file
    // never gets another line, so nothing here ends on its own.
    const authorize = () =>
      this.deployments.resolveLogSource(ctx, deploymentId);

    // One close code and one reason for every denial: an unknown deployment
    // and one the caller may not read are byte-identical on the wire, so the
    // socket is not a deployment-id enumeration oracle. Which of the two it
    // was goes to the journal, where only an operator sees it.
    let logPath: string;
    let serverId: string | null;
    let createdAt: string | null;
    try {
      ({ logPath, serverId, createdAt } = await authorize());
    } catch (error) {
      denyConnection(
        ws,
        this.logger,
        ctx,
        `deployment ${deploymentId}: ${journalDetailOf(error)}`,
      );
      return;
    }

    // Defense in depth, not the boundary: the path came off a row the caller is
    // entitled to, but a row minted before the tightened `APP_NAME_REGEX` can
    // hold `..`, so a composed log path can still climb out of the tree it
    // belongs in. The build server picks which
    // tree that is.
    if (!readValidDirectory(logPath, serverId)) {
      this.logger.error(
        `Deployment ${deploymentId} has a log path outside the platform directory: ${logPath}`,
      );
      denyConnection(
        ws,
        this.logger,
        ctx,
        `deployment ${deploymentId}: bad path`,
      );
      return;
    }

    // Past ADR-0020's window the file this socket would follow has been reaped,
    // and `tail -n +1 -f` on a file that is not there prints one stderr line
    // and then follows nothing for ever — a socket that stays open saying
    // nothing. So the socket answers the same thing `GET /deployments/:id/logs`
    // answers, and answers it *as a close* rather than as a frame:
    // `REAPED_LOG_CLOSE_CODE`'s docblock carries both halves of that decision
    // and the measurement behind the elision.
    //
    // After `readValidDirectory`, deliberately. A stored path that has escaped
    // the tree is a denial whatever the row's age, and answering "reaped" for
    // one would be telling an operator their log expired when the truth is that
    // this gateway would not have read it anyway.
    //
    // Before the lease and the keep-alive, because there is nothing to hold
    // open: neither has a subject once this returns, and arming a 30-second
    // renewal against a socket that is already closing is work for no reader.
    //
    // **Both halves of the read's predicate.** This asked
    // `isPastLogRetention` alone, and age is only a *proxy* for absence: the
    // sweep is a nightly cron, `-mtime +N` keeps a log up to a day longer than
    // the constant says, and it is best-effort per machine, so a Server
    // unreachable at 04:20 keeps its logs while every row on it ages past the
    // window. For those Deployments `readLogs` streamed the log — its own test
    // is `!stdout.trim() && isPastLogRetention(createdAt)` — while this closed
    // `4013` saying it had been reaped, which is the disagreement two
    // paragraphs up inverted rather than closed. The age test stays as the
    // cheap pre-filter, so a Deployment inside the window costs exactly the
    // round trips it did; `logFileIsAbsent` confirms the file is gone on the
    // rare path past it, and answers *present* whenever nothing could be
    // established, because claiming a log was reaped is worse than falling
    // through to a tail that reports the failure itself.
    if (
      isPastLogRetention(createdAt) &&
      (await this.deployments.logFileIsAbsent(serverId, logPath))
    ) {
      // Its own verb, so the counts stay apart: nobody was refused
      // anything here — the caller is entitled, the row resolved, and the
      // answer is true. `Reaped log socket:` counted over a month is also the
      // only evidence that would reopen the size of the window, which a
      // `Refused socket:` line would bury among real denials. `log` rather than
      // `warn` for the same reason: routine, and not an operator's problem.
      this.logger.log(
        `Reaped log socket: deployment ${deploymentId} is past the log retention window and its log file is gone, for ${callerOf(ctx)}`,
      );
      ws.close(REAPED_LOG_CLOSE_CODE, reapedLogCloseReason());
      return;
    }

    armAuthorizationLease({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `deployment ${deploymentId}`,
      renewalIntervalMs: this.leaseRenewalIntervalMs,
      credentials: this.wsAuth,
      authorize,
    });
    // `tail -n +1 -f` on a finished deployment's log follows a file that will
    // never get another line, so this socket has no natural end and no traffic
    // either — exactly the shape where a peer can vanish unobserved.
    armKeepAlive({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `deployment ${deploymentId}`,
    });

    try {
      if (serverId) {
        // The path is smuggled through base64 so no shell metacharacters
        // survive into the remote command.
        const encodedPath = encodeBase64(logPath);
        const command = `tail -n +1 -f "$(echo '${encodedPath}' | base64 -d)"`;

        try {
          const channel = await this.sshChannels.open(
            { serverId },
            { command },
          );
          channel.onData((data) => sendIfOpen(ws, data));
          channel.onStderr((data) => sendIfOpen(ws, data));
          channel.onClose(() => ws.close());
          channel.onError((err) => {
            if (sendIfOpen(ws, `SSH error: ${err.message}`)) ws.close();
          });
          ws.on('close', () => channel.close());
        } catch (error) {
          if (sendIfOpen(ws, `SSH error: ${(error as Error).message}`)) {
            ws.close();
          }
        }
      } else {
        const channel = this.localProcesses.spawn('tail', [
          '-n',
          '+1',
          '-f',
          logPath,
        ]);

        channel.onData((data) => sendIfOpen(ws, data));
        channel.onStderr((data) => sendIfOpen(ws, `tail error: ${data}`));
        channel.onClose(() => ws.close());
        channel.onError(() => {
          if (ws.readyState === ws.OPEN) ws.close();
        });
        ws.on('close', () => channel.close());
      }
    } catch (error) {
      if (sendIfOpen(ws, (error as Error).message || 'An error occurred')) {
        ws.close();
      }
    }
  }
}
