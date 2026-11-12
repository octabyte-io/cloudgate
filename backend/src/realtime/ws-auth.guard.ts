import type { IncomingMessage } from 'node:http';
import { Injectable } from '@nestjs/common';
import type { AuthSession } from '../auth/auth.config';
import { AuthService } from '../auth/auth.service';
import type { CredentialHandle, ValidatedRequest } from '../auth/auth.service';
import type { WsClient } from './ws-client';

/** The caller of an authenticated WebSocket connection. */
export interface WsAuthContext {
  user: AuthSession['user'];
  session: NonNullable<ValidatedRequest['session']>;
  /**
   * The handle this socket re-reads its own credential by, for as long as it is
   * open (ADR-0012). Not optional: a socket that cannot re-read its caller
   * cannot hold an authorization lease, and a gateway must not be handed one it
   * has no way to renew.
   */
  credential: CredentialHandle;
}

/**
 * WebSocket counterpart of AuthGuard: validates the request on connection
 * and closes unauthenticated sockets.
 * Nest guards never run for raw `ws` connections (there is no message
 * envelope to intercept), so gateways call this from handleConnection.
 */
@Injectable()
export class WsAuthGuard {
  constructor(private readonly authService: AuthService) {}

  async authenticate(
    ws: WsClient,
    req: IncomingMessage,
  ): Promise<WsAuthContext | null> {
    const { user, session, credential } =
      await this.authService.validateRequest(req.headers);
    if (!user || !session || !credential) {
      ws.close();
      return null;
    }
    return { user, session, credential };
  }

  /**
   * Whether the caller of an open socket is still authenticated (ADR-0012).
   *
   * Delegated rather than implemented here on purpose: the answer is
   * `AuthService`'s to give, next to the `validateRequest` it is a second
   * implementation of, and the realtime module is the wrong place to invent a
   * second opinion about what makes a session valid. What this adds is the
   * socket's half of the question — the organization the caller was acting in
   * when the socket opened, which is theirs to have changed and not ours to
   * follow.
   *
   * Throws when the credential is gone, which is how an
   * {@link armAuthorizationLease} renewal learns to close the socket.
   */
  async assertStillAuthenticated(caller: {
    credential: CredentialHandle;
    session: { activeOrganizationId?: string | null };
  }): Promise<void> {
    await this.authService.assertCredentialAlive(
      caller.credential,
      caller.session.activeOrganizationId ?? null,
    );
  }
}
