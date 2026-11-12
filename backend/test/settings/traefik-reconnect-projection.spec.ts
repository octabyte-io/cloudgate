import { drizzle } from 'drizzle-orm/node-postgres';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import * as schema from '../../src/db/schema';
import type { DockerResourceService } from '../../src/settings/docker-resource.service';
import { TraefikSetupService } from '../../src/settings/traefik-setup.service';
import type { RemoteDockerFactory } from '../../src/docker/remote-docker.factory';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';

// `compose.composeFile` became `encryptedText`, joining
// `env` and `refreshToken`, and `encryptedText` decrypts on the way out of the
// driver — so a `findMany` with no `columns:` narrowing now runs AES-256-GCM
// over three columns of every isolated stack on a **boot path**, to read
// `appName` and nothing else. The falsifiable claim the ticket states is about
// the emitted SQL, so that is what this drives: the statement `pg` is handed.
//
// The double is a `pg`-shaped object rather than a stub of
// `db.query.compose.findMany`, because a stub of the query builder would pin
// the *options object* and the claim is about the *statement*. A projection is
// a thing drizzle compiles, so only the compiled text can answer whether a
// column is still being fetched — and only the text goes red if a later edit
// re-adds a `with:` whose relation drags the column back in.
type Statement = { text: string; params: unknown[] };

function recordingDb(): { db: DrizzleDB; statements: Statement[] } {
  const statements: Statement[] = [];
  const client = {
    query(config: { text?: string }, params: unknown[]) {
      statements.push({ text: config?.text ?? '', params });
      return Promise.resolve({ rows: [], fields: [] });
    },
  };
  return {
    db: drizzle(client as never, { schema }),
    statements,
  };
}

function traefikSetup(db: DrizzleDB): {
  service: TraefikSetupService;
  execAsync: jest.Mock;
} {
  const execAsync = jest.fn(() => Promise.resolve({ stdout: '', stderr: '' }));
  const service = new TraefikSetupService(
    db,
    {} as unknown as RemoteDockerFactory,
    {} as unknown as DockerResourceService,
    withArgvExec({
      execAsync,
      execAsyncRemote: execAsync,
    }) as unknown as RemoteExecService,
  );
  return { service, execAsync };
}

describe('TraefikSetupService.reconnectServicesToTraefik', () => {
  it('selects only the appName, so a Traefik reconnect decrypts no stack secret', async () => {
    const { db, statements } = recordingDb();
    const { service } = traefikSetup(db);

    await service.reconnectServicesToTraefik('server-1');

    expect(statements).toHaveLength(1);
    const [{ text }] = statements;
    expect(text).toContain('"app_name"');
    // The three `encryptedText` columns on this table. `compose_file` is the
    // one added last and the one the ticket names; `env` and `refresh_token`
    // were already decrypting on this path before it and come off with it,
    // because the narrowing is one clause for all three.
    expect(text).not.toContain('compose_file');
    expect(text).not.toContain('refresh_token');
    expect(text).not.toMatch(/"env"/);
  });

  it('still filters on the Server and on isolatedDeployment', async () => {
    const { db, statements } = recordingDb();
    const { service } = traefikSetup(db);

    await service.reconnectServicesToTraefik('server-1');

    const [{ text, params }] = statements;
    expect(text).toContain('server_id');
    expect(text).toContain('isolated_deployment');
    expect(params).toContain('server-1');
  });

  it('connects each isolated stack network by appName', async () => {
    const { db } = recordingDb();
    const { service, execAsync } = traefikSetup(db);
    jest
      .spyOn(db.query.compose, 'findMany')
      .mockResolvedValue([{ appName: 'alpha' }, { appName: 'beta' }] as never);

    await service.reconnectServicesToTraefik('server-1');

    const [, command] = execAsync.mock.calls[0] as [string, string];
    expect(command).toContain('docker network connect alpha');
    expect(command).toContain('docker network connect beta');
  });
});
