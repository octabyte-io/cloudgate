import type { Duplex } from 'node:stream';
import type { HostKeyCheck } from './host-key';

/**
 * Everything needed to open an SSH connection to a server.
 */
export interface ServerConnection {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /**
   * A stream already open to the machine's SSH port, which SSH runs over
   * instead of dialling `host`: a Stack VM's tunnel (`stack-vm-remote.ts`).
   * Every SSH client in the layer passes it on, so none can dial around it.
   */
  sock?: Duplex;
  /**
   * How the host key the machine presents is checked (`host-key.ts`,
   * ADR-0074). Required, so that whatever produces a connection says how its
   * host key is checked and no SSH client can dial one unchecked.
   */
  hostKey: HostKeyCheck;
}

/**
 * Resolves SSH connection details (including the private key) for a server.
 * Implemented by the servers module (phase 11); injected via
 * SERVER_KEY_PROVIDER so RemoteModule has no dependency on server storage.
 */
export interface ServerKeyProvider {
  getConnection(serverId: string): Promise<ServerConnection>;
}

export const SERVER_KEY_PROVIDER = Symbol('SERVER_KEY_PROVIDER');
