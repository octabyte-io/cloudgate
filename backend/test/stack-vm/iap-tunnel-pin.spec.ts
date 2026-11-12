import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { IAP_RELAY } from '../../src/stack-vm/iap-tunnel';

const read = (path: string) =>
  readFileSync(join(__dirname, '..', '..', '..', path), 'utf8');

/**
 * The tunnel a Stack VM on Google Cloud is reached through (ADR-0070) needs
 * no helper installed on the platform host: Cloudgate speaks IAP's relay
 * itself, over the `ws` client, which is pinned to one version, as the
 * Session Manager plugin is on AWS.
 */
describe('IAP_RELAY', () => {
  it('pins the WebSocket client the relay is spoken over to one exact version', () => {
    const backend = JSON.parse(read('backend/package.json')) as {
      dependencies: Record<string, string>;
    };
    const pinned = backend.dependencies.ws;
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);

    const lock = read('pnpm-lock.yaml');
    expect(lock).toContain(
      `      ws:\n        specifier: ${pinned}\n        version: ${pinned}\n`,
    );
  });

  it("speaks IAP's own relay over TLS", () => {
    expect(IAP_RELAY).toBe('wss://tunnel.cloudproxy.app');
  });
});
