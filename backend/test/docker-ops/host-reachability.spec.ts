import {
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import { DockerOpsService } from '../../src/docker-ops/docker-ops.service';
import {
  HOST_UNREACHABLE_CODE,
  isUnreachableCode,
  PLATFORM_HOST_UNREACHABLE_CODE,
} from '../../src/docker-ops/host-reachability';
import { SwarmService } from '../../src/docker-ops/swarm.service';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import {
  CONTAINER_DENIAL_MESSAGE,
  ContainerAccessService,
} from '../../src/realtime/container-access.service';
import { ExecError } from '../../src/remote/exec-error';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * X11-4, and now the container gate one layer down as well — the same
 * split, reaching the surfaces X11-4 left it out of. A unit spec rather than an addition to `docker-ops.e2e-spec.ts`, and
 * the exec boundary is the only double it needs: what is under test is which of
 * two failures a reader can tell apart, and both are shapes `RemoteExecService`
 * raises. An e2e run costs a Postgres and a machine-wide lock to assert the
 * same thing about a service that is `new`-able in three lines.
 *
 * The two shapes are the fixtures, and they are the real ones rather than a
 * convenient pair:
 *
 * - **`sshRefused`** is what `execAsyncRemote` rejects with off the `ssh2`
 *   client's `'error'` event — the command never reached a shell, so there is
 *   no exit code to carry. `127.0.0.1:1` on a live box produces exactly this,
 *   in milliseconds.
 * - **`dockerFailed`** is what it rejects with off the channel's `close` event:
 *   the command ran, `docker` exited nonzero, and the status is on the error.
 *
 * The expectation is independent of the code under test in the sense §1.7 asks
 * for: neither fixture is built by calling the classifier, and the assertions
 * are about the HTTP refusal the console sees rather than about the predicate.
 */

const SERVER_ID = 'srv-unreachable';

const sshRefused = () =>
  new ExecError('SSH connection error: connect ECONNREFUSED 127.0.0.1:1', {
    command: 'docker ps -a',
    serverId: SERVER_ID,
  });

const dockerFailed = () =>
  new ExecError('Remote command failed with exit code 1', {
    command: 'docker ps -a',
    serverId: SERVER_ID,
    exitCode: 1,
    stdout: '',
    stderr: 'Cannot connect to the Docker daemon',
  });

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

/** The org-scope lookup every reader runs before it shells out. */
const makeDb = () => {
  const chain = {
    where: () => ({ limit: () => Promise.resolve([{ serverId: SERVER_ID }]) }),
  };
  return {
    select: () => ({ from: () => chain }),
  } as unknown as DrizzleDB;
};

const makePermissions = () =>
  ({
    checkPermission: jest.fn().mockResolvedValue(undefined),
    checkInstanceAuthority: jest.fn().mockResolvedValue(undefined),
  }) as unknown as PermissionService;

// `unknown` rather than `ExecError`: one case is a rejection that is
// *not* an `ExecError`, which is the arm `isTransportFailure` deliberately reads
// as "not a transport failure".
const makeRemoteExec = (error: unknown) => {
  const reject = jest.fn().mockRejectedValue(error);
  return {
    execAsync: reject,
    execAsyncRemote: reject,
    execFileAsync: reject,
    execRemote: reject,
  } as unknown as RemoteExecService;
};

const makeDockerOps = (error: ExecError) =>
  new DockerOpsService(makeDb(), makePermissions(), makeRemoteExec(error), {
    foreignAppNames: jest.fn().mockResolvedValue(new Set<string>()),
    authorizeContainer: jest.fn().mockResolvedValue(undefined),
    // The appName-keyed reads are gated before they shell out; cleared
    // here so every assertion stays about reachability.
    authorizeAppName: jest.fn().mockResolvedValue(undefined),
    // The listing asks this before it shells out. `true` — the caller
    // administers the instance — so every assertion below stays about
    // reachability and nothing else; the row filter it feeds is asserted
    // against real member rows in `docker-ops.e2e-spec.ts`.
    hasMachineAuthority: jest.fn().mockResolvedValue(true),
  } as unknown as ContainerAccessService);

const makeSwarm = (error: ExecError) =>
  new SwarmService(makeDb(), makePermissions(), makeRemoteExec(error));

/** The refusal, unwrapped — status and `code` are what the console branches on. */
async function refusalOf(call: Promise<unknown>) {
  try {
    await call;
    return null;
  } catch (error) {
    if (!(error instanceof ServiceUnavailableException)) throw error;
    return {
      status: error.getStatus(),
      body: error.getResponse() as { message: string; code: string },
    };
  }
}

describe('DockerOpsService.getContainers', () => {
  it('refuses 503 with a HOST_UNREACHABLE code when the Server was never reached', async () => {
    const refusal = await refusalOf(
      makeDockerOps(sshRefused()).getContainers(ctx, { serverId: SERVER_ID }),
    );

    expect(refusal).not.toBeNull();
    expect(refusal?.status).toBe(503);
    expect(refusal?.body.code).toBe(HOST_UNREACHABLE_CODE);
    expect(refusal?.body.message).toBe('This Server could not be reached');
  });

  it('keeps the SSH failure off the wire and names only the Server', async () => {
    const refusal = await refusalOf(
      makeDockerOps(sshRefused()).getContainers(ctx, { serverId: SERVER_ID }),
    );

    // ADR-0008's split: the journal attributes the failure, the wire states it.
    expect(refusal?.body.message).not.toContain('ECONNREFUSED');
    expect(refusal?.body.message).not.toContain('SSH');
  });

  it('answers nothing rather than an empty listing when docker itself failed', async () => {
    // The reading was not taken either way, and the route's own `stderr` branch
    // already means *docker would not say*. What it must never mean is "there
    // are no containers on this host", which is what `[]` claimed.
    await expect(
      makeDockerOps(dockerFailed()).getContainers(ctx, {
        serverId: SERVER_ID,
      }),
    ).resolves.toBeUndefined();
  });

  it('refuses 503 naming the platform host when no serverId was given', async () => {
    const refusal = await refusalOf(
      makeDockerOps(sshRefused()).getContainers(ctx, {}),
    );

    expect(refusal?.body.message).toBe(
      'The platform host could not be reached',
    );
    // **And a code of its own,.** The sentence was already right and
    // the console never saw it: it branches on the code, so one code for two
    // subjects rendered *"check that its SSH key still works"* about a machine
    // with no Server row. Asserted as *not* the Server's code as well as as its
    // own, because the defect was the two being equal.
    expect(refusal?.body.code).toBe(PLATFORM_HOST_UNREACHABLE_CODE);
    expect(refusal?.body.code).not.toBe(HOST_UNREACHABLE_CODE);
  });
});

/**
 * The union both arms are read through where the *subject* does not matter
 * — `socket-access.ts`'s `isHostUnreachable`, and the console's retry
 * policy, which skips the retries for either.
 *
 * Worth its own cases because the predicate is what stopped the code change from being a
 * silent regression on the sockets, and because the shape it must refuse is a
 * substring test: `PLATFORM_HOST_UNREACHABLE` contains `HOST_UNREACHABLE`, so
 * anything written with `includes` would read the Server's code out of the
 * platform's and vice versa.
 */
describe('isUnreachableCode', () => {
  it('accepts either arm and nothing else', () => {
    expect(isUnreachableCode(HOST_UNREACHABLE_CODE)).toBe(true);
    expect(isUnreachableCode(PLATFORM_HOST_UNREACHABLE_CODE)).toBe(true);
    expect(isUnreachableCode('BANNED_USER')).toBe(false);
    expect(isUnreachableCode('')).toBe(false);
    expect(isUnreachableCode(undefined)).toBe(false);
  });

  it('is an equality test rather than a substring one', () => {
    // The two codes are distinct strings, and one contains the other. A guard
    // written as `String(code).includes('HOST_UNREACHABLE')` passes the case
    // above and accepts `NOT_HOST_UNREACHABLE_AT_ALL` with it.
    expect(PLATFORM_HOST_UNREACHABLE_CODE).not.toBe(HOST_UNREACHABLE_CODE);
    expect(PLATFORM_HOST_UNREACHABLE_CODE).toContain(HOST_UNREACHABLE_CODE);
    expect(isUnreachableCode(`NOT_${HOST_UNREACHABLE_CODE}_AT_ALL`)).toBe(
      false,
    );
  });
});

describe('DockerOpsService.getContainersByOwnerLabel', () => {
  it('refuses 503 when the Server was never reached', async () => {
    const refusal = await refusalOf(
      makeDockerOps(sshRefused()).getContainersByOwnerLabel(ctx, {
        appName: 'my-stack',
        serverId: SERVER_ID,
      }),
    );

    expect(refusal?.status).toBe(503);
    expect(refusal?.body.code).toBe(HOST_UNREACHABLE_CODE);
  });

  it('answers an empty listing when the search ran and docker failed', async () => {
    // A docker that ran and exited nonzero is still `[]` here — only the
    // transport failure was taken out of the swallow (X11-4).
    await expect(
      makeDockerOps(dockerFailed()).getContainersByOwnerLabel(ctx, {
        appName: 'nope',
        serverId: SERVER_ID,
      }),
    ).resolves.toEqual([]);
  });
});

describe('SwarmService.getSwarmNodes', () => {
  it('refuses 503 when the Server was never reached', async () => {
    const refusal = await refusalOf(
      makeSwarm(sshRefused()).getSwarmNodes(ctx, { serverId: SERVER_ID }),
    );

    expect(refusal?.status).toBe(503);
    expect(refusal?.body.code).toBe(HOST_UNREACHABLE_CODE);
  });

  it('answers nothing when the node listing ran on a worker and failed', async () => {
    await expect(
      makeSwarm(dockerFailed()).getSwarmNodes(ctx, { serverId: SERVER_ID }),
    ).resolves.toBeUndefined();
  });
});

describe('SwarmService.getNodeApplications', () => {
  it('refuses 503 when the Server was never reached', async () => {
    const refusal = await refusalOf(
      makeSwarm(sshRefused()).getNodeApplications(ctx, {
        serverId: SERVER_ID,
      }),
    );

    expect(refusal?.status).toBe(503);
    expect(refusal?.body.code).toBe(HOST_UNREACHABLE_CODE);
  });

  it('answers nothing rather than an empty service list when docker failed', async () => {
    await expect(
      makeSwarm(dockerFailed()).getNodeApplications(ctx, {
        serverId: SERVER_ID,
      }),
    ).resolves.toBeUndefined();
  });
});

/**
 * The one place the split had to be *argued* rather than applied:
 * this gate's catch answered `403 Container not found or not permitted` for
 * every failure, so an unreachable Server's containers were refused with an
 * authorization claim about a machine nothing spoke to — on
 * `GET /docker/containers/:id/config`, the five lifecycle verbs, the upload and
 * the three container sockets, the eleven surfaces it gates. An earlier fix made that
 * byte-identical denial a security property, so widening it is a decision about
 * ADR-0008 and not a patch; the ADR carries the amendment and the argument.
 *
 * In this file rather than only in `docker-ops.e2e-spec.ts` for the reason the
 * header gives: what is under test is which of two exec failures a reader can
 * tell apart, and `resolveTarget` needs neither a database nor a permission
 * check to answer — it inspects and classifies, and both fixtures are shapes
 * `RemoteExecService` really raises. The **route** statuses, and the pairing
 * with the 403s that must not move, are pinned over there against a real app;
 * the socket close frames are `test/realtime/container-socket-unreachable.spec.ts`.
 */
describe('ContainerAccessService.resolveTarget', () => {
  const makeAccess = (error: unknown) =>
    new ContainerAccessService(
      makeDb(),
      makePermissions(),
      makeRemoteExec(error),
    );

  const onServer = { containerId: 'abc123', serverId: SERVER_ID };

  /** What `docker inspect` rejects with once it has run and answered. */
  const noSuchContainer = () =>
    new ExecError('Remote command failed with exit code 1', {
      command: 'docker inspect --type container abc123',
      serverId: SERVER_ID,
      exitCode: 1,
      stderr: 'Error: No such container: abc123',
    });

  it('refuses 503 with a HOST_UNREACHABLE code when the inspect never ran', async () => {
    const refusal = await refusalOf(
      makeAccess(sshRefused()).resolveTarget(onServer),
    );

    expect(refusal?.status).toBe(503);
    expect(refusal?.body.code).toBe(HOST_UNREACHABLE_CODE);
    expect(refusal?.body.message).toBe('This Server could not be reached');
    // And it says nothing about the container it was asked about, which is the
    // half the byte-identical denial is owed: the message is about the machine.
    expect(refusal?.body.message).not.toContain('abc123');
    expect(refusal?.body.message).not.toContain('ECONNREFUSED');
  });

  it('names the platform host when the target is on it', async () => {
    const refusal = await refusalOf(
      makeAccess(sshRefused()).resolveTarget({ containerId: 'abc123' }),
    );

    expect(refusal?.body.message).toBe(
      'The platform host could not be reached',
    );
    // The code too, — and this gate is the one the container sockets
    // reach, so the arm they close on comes from here.
    expect(refusal?.body.code).toBe(PLATFORM_HOST_UNREACHABLE_CODE);
  });

  it('still refuses 403 with the one denial message when docker ran and said no', async () => {
    // The case that catches a fix written as "any exec rejection is a transport
    // failure": the command reached a shell and exited nonzero, so the
    // resolution *happened* and its outcome is a denial (ADR-0008).
    const call = () => makeAccess(noSuchContainer()).resolveTarget(onServer);

    await expect(call()).rejects.toThrow(ForbiddenException);
    await expect(call()).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
  });

  it('still refuses 403 for a rejection that did not come from the exec layer', async () => {
    // A plain `Error` reads as "not a transport failure" on purpose — it says
    // nothing about the transport — and it is the shape the existing e2e pins
    // reject with, which is why none of them moves.
    const call = () =>
      makeAccess(new Error('no such container')).resolveTarget(onServer);

    await expect(call()).rejects.toThrow(ForbiddenException);
    await expect(call()).rejects.toThrow(CONTAINER_DENIAL_MESSAGE);
  });

  it('logs each failure once, and the host’s own words only for the transport arm', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await makeAccess(sshRefused())
        .resolveTarget(onServer)
        .catch(() => undefined);

      // `rethrowIfHostUnreachable`'s own line, and not also the catch's
      // reachable-arm line: one failure, one record.
      expect(warn.mock.calls.map(([line]) => String(line))).toEqual([
        `Server ${SERVER_ID} was not reached: ${sshRefused().message}`,
      ]);

      warn.mockClear();
      await makeAccess(noSuchContainer())
        .resolveTarget(onServer)
        .catch(() => undefined);

      // The other arm, whose line is the one that was always there.
      const denied = warn.mock.calls.map(([line]) => String(line));
      expect(denied).toHaveLength(1);
      expect(denied[0]).toContain('Could not inspect abc123');
      expect(denied[0]).not.toContain('was not reached');
    } finally {
      warn.mockRestore();
    }
  });
});
