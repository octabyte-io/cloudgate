import type { IncomingMessage } from 'node:http';
import { ForbiddenException, Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway } from '@nestjs/websockets';
import { PermissionService } from '../../rbac/permission.service';
import { unverifiedHostKey } from '../../remote/host-key';
import { ServersService } from '../../servers/servers.service';
import { SshChannelService } from '../channels/ssh-channel.service';
import type { SshTarget } from '../channels/ssh-channel.service';
import {
  LocalServerSetupService,
  localSshKeyPath,
  sshDirectory,
} from '../local-server-setup.service';
import {
  entitledToServerOrThrow,
  findAuthorizedServer,
} from '../server-access';
import {
  armAuthorizationLease,
  armKeepAlive,
  callerOf,
  LEASE_RENEWAL_INTERVAL,
  sendIfOpen,
} from '../socket-access';
import {
  bridgeTerminalInput,
  captureInitialSize,
  SHELL_OPEN_FRAME,
  TERMINAL_CLOSE,
  terminalCloseReason,
} from '../terminal-protocol';
import type { WsAuthContext } from '../ws-auth.guard';
import { WsAuthGuard } from '../ws-auth.guard';
import type { WsClient } from '../ws-client';

/**
 * The two commands an operator may have to run on the host to make the local
 * terminal work, and the one thing about them that has to stay true: every path
 * in them is *this instance's* tree, so they are built per call from
 * CLOUDGATE_DIRECTORY rather than frozen at import. They used to name
 * `/etc/cloudgate/ssh` literally, which sends an operator who relocated the
 * directory to cat a file that is not there.
 */
const commandToAllowLocalAccess = () => `
# ----------------------------------------
mkdir -p $HOME/.ssh && \\
chmod 700 $HOME/.ssh && \\
touch $HOME/.ssh/authorized_keys && \\
chmod 600 $HOME/.ssh/authorized_keys && \\
cat ${localSshKeyPath()}.pub >> $HOME/.ssh/authorized_keys && \\
echo "✓ Cloudgate SSH key added successfully. Reopen the terminal in Cloudgate to reconnect."
# ----------------------------------------`;

const commandToGrantPermissionAccess = () => `
# ----------------------------------------
sudo chown -R $USER:$USER ${sshDirectory()}
# ----------------------------------------
`;

/**
 * What the browser is told when it may not have a shell on the platform host.
 *
 * Said plainly rather than folded into `socket-access.ts`'s one denial frame
 * (ADR-0008): that frame is byte-identical across not-entitled and unknown-id
 * because telling them apart lets a caller walk another organization's id
 * space, and `local` is not an id — it is the machine serving the console,
 * whose existence every caller has already proved by connecting to it. There is
 * nothing here to enumerate, and an operator who is refused deserves to know
 * that the answer is their role rather than a broken proxy (ADR-0010).
 */
export const HOST_SHELL_REFUSAL =
  'Only an owner or admin may open a shell on the platform host';

/**
 * A line a gateway wrote itself, in the line discipline the console expects.
 *
 * The emulator runs `convertEol: false` — `use-terminal-emulator.ts`, and the
 * reason is on the line above it: a pty echoes already, so converting or echoing
 * there would double the shell's own output. A lone LF therefore moves the
 * cursor down without returning the carriage, and every frame this gateway
 * composed itself started under the end of the previous one: the whole pre-shell
 * transcript staircased, including the eight-line `authorized_keys` remediation
 * shown to a refused operator, which is meant to be selected and
 * pasted.
 *
 * Flipping `convertEol` was the alternative and is wrong twice over: it is
 * documented against for a reason that is still true, and it would rewrite the
 * pty's own bytes for the container terminal as well. So the carriage return is
 * added here, on the way out, and only to text this codebase wrote —
 * `channel.onData`/`onStderr` stay untouched, which is why everything after the
 * SSH channel opens always rendered correctly.
 *
 * Idempotent: text already ending its lines CRLF is unchanged. Exported because
 * `container-terminal.gateway.ts` writes into the same emulator and had the same
 * defect in four frames of its own.
 */
export const terminalLine = (text: string): string =>
  text.replace(/\r?\n/g, '\r\n');

/**
 * The /terminal socket: an interactive SSH shell on a server —
 * a stored server row, or "local" for the host the platform runs on
 * (reached over SSH with an auto-generated key).
 *
 * What the browser may say on this socket — input, and the one resize control
 * frame — is `terminal-protocol.ts`. Read it before touching the message wiring.
 *
 * **Every exit from here closes the socket, with a code and a reason.** The
 * shape this gateway had was: write the failure into the terminal and return.
 * The operator then had a console with an error in it, a green "running" badge
 * over it, and a keyboard whose every keystroke went into a socket attached to
 * nothing — a shell that looks fine and does nothing, rather than one that
 * failed. The frames stay; they carry what a close code cannot.
 *
 * **Both branches authorize, and they ask different questions** (ADR-0010). A
 * Server row is resolved org-scoped and then held to the `server:read`
 * entitlement its own routes require. `local` has no row to resolve, so the
 * question there is whether the caller administers this instance at all —
 * owner or admin of their active organization — because what is on the other
 * end of that branch is a root shell on the machine the platform runs on.
 */
@WebSocketGateway({ path: '/terminal' })
export class ServerTerminalGateway implements OnGatewayConnection {
  private readonly logger = new Logger(ServerTerminalGateway.name);

  constructor(
    private readonly wsAuth: WsAuthGuard,
    private readonly servers: ServersService,
    private readonly sshChannels: SshChannelService,
    private readonly localSetup: LocalServerSetupService,
    private readonly permissions: PermissionService,
    @Inject(LEASE_RENEWAL_INTERVAL)
    private readonly leaseRenewalIntervalMs: number,
  ) {}

  async handleConnection(ws: WsClient, req: IncomingMessage) {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const serverId = url.searchParams.get('serverId');

    // Before the first await: a browser sends its size as soon as the socket is
    // open, and that is long before the SSH channel it is meant for exists.
    const initialSize = captureInitialSize(ws);

    const auth = await this.wsAuth.authenticate(ws, req);
    if (!auth) return;
    if (!serverId) {
      this.refuse(ws, auth, TERMINAL_CLOSE.badRequest, 'serverId not provided');
      return;
    }

    const isLocalServer = serverId === 'local';
    let target: SshTarget;
    // The authorization this socket holds for as long as it is open, and the two
    // branches ask different questions (ADR-0010), so each builds its own. It is
    // run once here and then on a clock: a shell is the sharpest capability in
    // the product, and it used to keep running for whoever opened it however
    // long ago (ADR-0012).
    let authorize: () => Promise<unknown>;

    if (isLocalServer) {
      // Before the parameters, and long before anything is written to the host:
      // this branch opens a shell on the machine Cloudgate itself runs on, and
      // it had no authorization of any kind (ADR-0010).
      authorize = () => this.assertMayShellIntoTheHost(auth);
      try {
        await authorize();
      } catch {
        this.refuse(ws, auth, TERMINAL_CLOSE.forbidden, HOST_SHELL_REFUSAL);
        return;
      }

      const portParameter = url.searchParams.get('port');
      const port = Number(portParameter);
      const username = url.searchParams.get('username');

      if (!portParameter || !username) {
        this.refuse(
          ws,
          auth,
          TERMINAL_CLOSE.badRequest,
          'port and username are required for serverId=local',
        );
        return;
      }
      // Checked here rather than left to ssh2, which answers a bad port with
      // `Port should be >= 0 and < 65536. Received type number (99999)` thrown
      // from its own argument validation — reported as `4500` because the outer
      // catch cannot tell that from a dial that failed, so a request that was
      // simply wrong read as a machine that could not be reached, in a
      // library's internal words. `badRequest`'s docblock above already
      // claims this case.
      //
      // The bound is the one the console applies twice —
      // `local-shell-values.ts`'s `checkLocalShell` and
      // `terminal-session.tsx`'s `localDial` — so the console cannot send a bad
      // one. That is exactly why the gateway has to: a raw `ws` upgrade runs no
      // Nest guard and no zod pipe, so this parameter has no other checker.
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        this.refuse(
          ws,
          auth,
          TERMINAL_CLOSE.badRequest,
          'port must be a whole number from 1 to 65535',
        );
        return;
      }

      try {
        this.say(ws, 'Setting up private SSH key...\n');
        const privateKey = await this.localSetup.setupSshKey();

        if (!privateKey) {
          this.refuse(
            ws,
            auth,
            TERMINAL_CLOSE.keyUnavailable,
            'no local SSH key on this host',
          );
          return;
        }

        const dockerHost = await this.localSetup.getDockerHost();
        this.say(ws, `Found Docker host: ${dockerHost}\n`);

        target = {
          connection: {
            host: dockerHost,
            port,
            username,
            privateKey,
            // The platform host has no Server row to record a host key on,
            // and this dials from the backend's container to the Docker host
            // it runs on (ADR-0074).
            hostKey: unverifiedHostKey(),
          },
        };
      } catch (error) {
        this.say(ws, `Error setting up private SSH key: ${String(error)}\n`);

        if (
          error instanceof Error &&
          error.message.includes('Permission denied')
        ) {
          this.say(
            ws,
            `Please run the following command on your server to grant permission access and then reopen this window to reconnect:${commandToGrantPermissionAccess()}`,
          );
        }

        this.refuse(
          ws,
          auth,
          TERMINAL_CLOSE.keyUnavailable,
          `local SSH key unavailable: ${(error as Error).message}`,
        );
        return;
      }
    } else {
      const server = await findAuthorizedServer(this.servers, auth, serverId, {
        logger: this.logger,
        subject: '/terminal',
      });
      // Silent and codeless on purpose — this exit and the entitlement one
      // below are the two that stay so: an id that is not the caller's and an
      // id that does not exist have to be indistinguishable, or the socket
      // enumerates another organization's Servers (ADR-0008). The other
      // gateways refuse the same way.
      if (!server) {
        ws.close();
        return;
      }
      // And the same entitlement the Server's own routes ask for. `GET
      // /servers/:id` carries @RequirePermission('server', 'read') and Nest
      // guards never run for a raw ws upgrade, so the check is made by hand
      // here — `memberRole` grants no `server` action at all, so a base member
      // cannot so much as list the fleet, and could still be handed a root SSH
      // shell on any machine in it by naming its id (the asymmetry ADR-0008
      // describes, on the one socket it did not cover).
      //
      // Refused the way the line above refuses, and for the same reason: to a
      // caller who may not see the fleet, "you may not have this one" confirms
      // the id exists. The journal keeps the difference.
      // The entitlement `GET /servers/:id` carries, asked by hand because Nest
      // guards never run for a raw ws upgrade — and asked again on a clock,
      // because a shell at a prompt outlives the grant that opened it.
      authorize = () =>
        entitledToServerOrThrow(
          { servers: this.servers, permissions: this.permissions },
          auth,
          serverId,
          'read',
        );
      try {
        await authorize();
      } catch {
        // `callerOf(auth)` rather than `server.organizationId`: the same value
        // by construction, and the same shape as every other line, so one grep
        // finds them all.
        this.logger.warn(
          `Refused socket: /terminal not entitled to Servers in this organization for ${callerOf(
            auth,
          )}`,
        );
        ws.close();
        return;
      }
      if (!server.sshKeyId) {
        this.say(ws, 'No SSH key available for this server');
        this.refuse(
          ws,
          auth,
          TERMINAL_CLOSE.keyUnavailable,
          'no SSH key is configured for this Server',
        );
        return;
      }
      target = { serverId };
    }

    // The socket may have closed while it was being authorized. Its
    // `'close'` has fired already and will not fire again, so a channel opened
    // now would have nothing to close it, and the shell behind it would stay
    // open on the machine.
    if (ws.readyState !== ws.OPEN) return;

    armAuthorizationLease({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `/terminal ${serverId}`,
      renewalIntervalMs: this.leaseRenewalIntervalMs,
      credentials: this.wsAuth,
      authorize,
    });
    // What makes a vanished peer observable at all: a shell sitting at a
    // prompt sends nothing and receives nothing, so without a ping there is no
    // moment at which this socket — and the SSH channel behind it — is noticed
    // to have no reader left.
    armKeepAlive({
      ws,
      logger: this.logger,
      caller: auth,
      subject: `/terminal ${serverId}`,
    });

    this.say(ws, 'Connecting...\n');

    try {
      const channel = await this.sshChannels.open(target, {
        ...initialSize.take(),
      });
      // Closed while SSH was dialling: the same missed `'close'`, with
      // a shell already open at the far end.
      if (ws.readyState !== ws.OPEN) {
        channel.close();
        return;
      }

      // The shell is open: the console's pill waits for this, not the socket.
      // Before the reset, so it precedes every byte of the channel's.
      sendIfOpen(ws, SHELL_OPEN_FRAME);
      // Clear terminal content once connected.
      this.say(ws, '\x1bc');

      // The pty's own bytes, which already carry CRLF — `terminalLine` must not
      // touch them. The `readyState` guard is not about the bytes and
      // does apply: a shell keeps writing into a socket the keep-alive dropped.
      channel.onData((data) => sendIfOpen(ws, data));
      channel.onStderr((data) => sendIfOpen(ws, data));
      channel.onClose((code) => {
        // Two things were wrong here. The noun was copied from
        // `container-terminal.gateway.ts`, where the far end really is a
        // container; on this socket it is a pty behind an SSH channel, on a
        // Server or on the platform host, and `CONTEXT.md` reserves *container*
        // for something this is not. And ssh2 reports no exit code at all when
        // the far end was killed by a signal rather than exiting —
        // `stream-channel.ts` types the argument optional — so template
        // interpolation printed the absence as the word `null`, in the frame and
        // in the close reason: "shell exited with code null" describes something
        // that did not happen, because nothing exited.
        //
        // Both branches keep `shellClosed`: a killed shell is still a shell that
        // ended, and nothing went wrong here that the operator did.
        const ended =
          typeof code === 'number'
            ? {
                line: `The shell exited with code ${code}.`,
                reason: `shell exited with code ${code}`,
              }
            : {
                line: 'The shell ended without an exit code.',
                reason: 'shell ended without an exit code',
              };
        this.say(ws, `\n${ended.line}\n`);
        this.end(ws, TERMINAL_CLOSE.shellClosed, ended.reason);
      });
      channel.onError((err) => {
        this.say(ws, `SSH connection error: ${err.message} ❌ `);
        this.fail(ws, auth, TERMINAL_CLOSE.sshFailed, `ssh: ${err.message}`);
      });
      // The channel exists now, so resizes go to it rather than into the
      // capture — including one that arrived while it was being opened.
      initialSize.handOver(channel);
      bridgeTerminalInput(ws, channel);
      ws.on('close', () => channel.close());
    } catch (error) {
      const err = error as Error & { level?: string };
      if (err.level === 'client-authentication') {
        if (isLocalServer) {
          this.say(
            ws,
            `Authentication failed: Please run the command below on your server to allow access. Make sure to run it as the same user as the one configured in connection settings:${commandToAllowLocalAccess()}\nAfter running the command, reopen this window to reconnect. This procedure is required only once.`,
          );
        } else {
          this.say(
            ws,
            `Authentication failed: Unauthorized private SSH key or username.\n❌  Error: ${err.message} ${err.level}`,
          );
        }
        this.fail(ws, auth, TERMINAL_CLOSE.authFailed, `ssh: ${err.message}`);
      } else {
        this.say(ws, `SSH connection error: ${err.message} ❌ `);
        this.fail(ws, auth, TERMINAL_CLOSE.sshFailed, `ssh: ${err.message}`);
      }
    }
  }

  /**
   * That this caller may open a shell on the machine Cloudgate runs on
   * (ADR-0010).
   *
   * Throws rather than answering false: the connection handler turns the throw
   * into its own `4403` frame, and a lease renewal turns the same throw into a
   * `4010` — one implementation of the question, two ways of refusing it.
   *
   * `findAuthorizedServer` cannot be reused: the platform host has no `server`
   * row, which is exactly why this branch exists, and `checkServerAccess`'s
   * own contract across the HTTP surface is that an absent serverId means "no
   * row to check". So the question changes shape — not *may you reach this
   * row*, but *do you administer this instance*.
   *
   * **That question now has a real answer, and this is the call site ADR-0010
   * asked to move.** Its last consequence said so in as many words: *"There is
   * no instance-level authority in this codebase to gate on, and this decision
   * does not invent one … an owner or admin of **any** organization on the
   * instance passes … If an instance-level role is ever introduced, this is one
   * of the call sites that should move to it."* ADR-0013 introduced one, for a
   * Traefik file; a root shell here is strictly more than any Traefik file, and
   * it reaches every organization's containers, the Postgres this instance runs
   * on and the secret every `encryptedText` column is sealed with. So it moved
   * (H-63), and `checkInstanceAuthority` carries the reasoning and the evidence
   * that gating on the instance organization cannot lock an operator out.
   *
   * The organization role is what this used to read, and it was ADR-0010's own
   * stated ceiling rather than a mistake — the admin-plugin `user.role` is
   * `'user'` for everybody on a self-hosted install (H-10), so at the time the
   * member row really was this codebase's only expression of administration.
   * What changed is that there is now a *particular* organization to ask about.
   *
   * Still a static role rather than a statement like `server:create`: a
   * statement can be granted to a licensed custom role, which would hand out the
   * host under a name that does not mention it (ADR-0010's first consequence,
   * ADR-0013's third).
   *
   * The wire is untouched. `HOST_SHELL_REFUSAL` still says "Only an owner or
   * admin may open a shell on the platform host", which is true of the new gate
   * as it was of the old one and stays deliberately vague about *which*
   * organization — the console renders it verbatim, and a refused caller learns
   * nothing here about the instance's shape.
   */
  private async assertMayShellIntoTheHost(auth: WsAuthContext): Promise<void> {
    // Still refused rather than authorized unscoped, though the check below no
    // longer reads this id: `PermissionCtx` requires one, `socket-access.ts`
    // refuses a caller acting outside any organization for the same reason, and
    // a session with no active organization is not one this gateway should be
    // guessing an authority for. It cannot exclude the instance organization's
    // owner, who always has one.
    const organizationId = auth.session.activeOrganizationId;
    if (!organizationId) {
      throw new ForbiddenException(HOST_SHELL_REFUSAL);
    }
    try {
      // Throws `ForbiddenException` on a refusal and lets a database failure
      // through as itself — the distinction a lease depends on, since it ends on
      // a refusal and stands through a failure (ADR-0005, ADR-0012). A local
      // `catch { return null }` here would turn a pool timeout into a withdrawn
      // grant and drop every host shell in the instance.
      await this.permissions.checkInstanceAuthority({
        user: { id: auth.user.id },
        session: { activeOrganizationId: organizationId },
      });
    } catch (error) {
      // Re-worded, not re-thrown as-is: `checkInstanceAuthority`'s sentence is
      // an HTTP refusal, and this socket has one sentence of its own that the
      // console already knows how to render against `4403`. A non-Forbidden
      // failure is a failure and goes up untouched, so the lease stands through
      // it.
      if (error instanceof ForbiddenException) {
        throw new ForbiddenException(HOST_SHELL_REFUSAL);
      }
      throw error;
    }
  }

  /**
   * End the socket saying why. Idempotent by readyState: a channel that errors
   * after it has closed would otherwise close a socket that is already gone,
   * which `ws` throws on.
   */
  private end(ws: WsClient, code: number, reason: string): void {
    if (ws.readyState !== ws.OPEN) return;
    ws.close(code, terminalCloseReason(reason));
  }

  /**
   * A session that ended badly: the same close, and a line for the journal —
   * the operator's copy of what the browser was told.
   *
   * The caller is a parameter for the reason `refuse` below takes one and
   * `denyConnection` takes one: this line named the reason and not the user, so
   * an operator reading a run of `ssh: All configured authentication methods
   * failed` could not tell one member retrying from a Server refusing everybody.
   */
  private fail(
    ws: WsClient,
    caller: WsAuthContext,
    code: number,
    reason: string,
  ): void {
    if (ws.readyState !== ws.OPEN) return;
    this.logger.warn(
      `Terminal socket failed: ${reason} for ${callerOf(caller)}`,
    );
    this.end(ws, code, reason);
  }

  /**
   * A frame this gateway composed itself.
   *
   * One place, so the two multi-line command templates at the top of the file —
   * including the eight-line `authorized_keys` block shown to a
   * refused operator — are fixed without being edited, and so the
   * conversion is in one place. `channel.onData`/`onStderr` deliberately do not
   * come through here: those are the pty's own bytes, which already carry CRLF,
   * and rewriting them is what flipping `convertEol` in the browser would have
   * done — they go through `sendIfOpen` directly, which is the half of this that
   * does apply to them.
   *
   * Answers whether the frame went out, matching the sibling in
   * `container-terminal.gateway.ts`, whose two callers close only if it did.
   */
  private say(ws: WsClient, text: string): boolean {
    return sendIfOpen(ws, terminalLine(text));
  }

  /**
   * Refuse before a shell exists, and record who was refused.
   *
   * `socket-access.ts`'s `denyConnection` is not reusable here: it exists to
   * make every refusal byte-identical, which is right for an id that may not be
   * the caller's and wrong for a request that is simply incomplete — the caller
   * needs to be told *which* parameter, and there is nothing to leak in saying
   * so. The journal line follows its `Refused socket:` shape so an operator
   * greps one thing.
   */
  private refuse(
    ws: WsClient,
    caller: WsAuthContext,
    code: number,
    reason: string,
  ): void {
    this.logger.warn(
      `Refused socket: /terminal ${reason} for ${callerOf(caller)}`,
    );
    this.end(ws, code, reason);
  }
}
