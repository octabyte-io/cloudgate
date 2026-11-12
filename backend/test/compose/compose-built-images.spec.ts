import {
  composeBuiltImageTags,
  reclaimComposeBuiltImages,
} from '../../src/compose/compose-images';
import type { ComposeBuiltImageOwner } from '../../src/compose/compose-images';
import { awaitImageRelease } from '../../src/common/teardown-steps';
import type { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';

/**
 * Reclaiming a stack's built images, and the half that had to be established
 * before any of it could be written: **what a Compose stack's built images are
 * actually called.**
 *
 * `docker compose build` names an image after the *compose project* and the
 * *service*, not after `appName` alone — and a service may pin `image:` itself,
 * in which case the build is tagged with the operator's own reference. So the
 * question "can a stack's built images be named from the row" has three answers
 * rather than one, and the numbers below are measured on the same host the rest
 * of the tree's Docker facts are measured on (**Docker 29.3.1, Compose
 * v5.1.1**), against a two-service project built with
 * `docker compose -p cg-probe-stack build`:
 *
 * - a service with `build:` and no `image:` → `cg-probe-stack-web:latest`, i.e.
 *   `${project}-${service}`, which Docker reads as `:latest`. That is
 *   `${appName}-${service}` here, because `createComposeCommand` passes
 *   `-p ${appName}` and `getCreateComposeEnvFileCommand` writes
 *   `COMPOSE_PROJECT_NAME=${appName}` beside it.
 * - a service with `build:` **and** `image: my-own-name:7` → `my-own-name:7`.
 *   The platform ran the build; the operator chose the name. Not reclaimed —
 *   The docker-source rule one table along.
 * - a service with only `image:` → nothing built at all.
 *
 * The interpolation is verbatim rather than sanitized: `cg-probe-two-Web.Three`
 * was attempted and Docker refused the tag (*"repository name must be
 * lowercase"*), so a service name that would not make a legal reference means
 * the build already failed and there is nothing to reclaim.
 */

const OWNER: ComposeBuiltImageOwner = {
  appName: 'wp-stack',
  composeType: 'docker-compose',
  command: '',
  serverId: 'srv-1',
};

const TWO_BUILDS = `services:
  web:
    build: .
  api:
    build:
      context: ./api
      dockerfile: Dockerfile.api
  db:
    image: mariadb:11
`;

describe('composeBuiltImageTags', () => {
  it('names one image per service the platform tagged itself', () => {
    expect(composeBuiltImageTags(OWNER, TWO_BUILDS)).toEqual([
      'wp-stack-web:latest',
      'wp-stack-api:latest',
    ]);
  });

  it('names nothing for a service that only pulls an image', () => {
    expect(
      composeBuiltImageTags(OWNER, 'services:\n  db:\n    image: mariadb:11\n'),
    ).toEqual([]);
  });

  it('names nothing for a build whose image the operator chose', () => {
    // The whole of the docker-source rule, one table along: the platform
    // built it, under a reference it did not pick. `docker image rm` on it
    // could untag something every other stack on the host is running, and it
    // may be a registry reference the operator pushes.
    expect(
      composeBuiltImageTags(
        OWNER,
        'services:\n  web:\n    build: .\n    image: myorg/web:1.2\n',
      ),
    ).toEqual([]);
  });

  it('names nothing for a swarm stack, which builds nothing', () => {
    // `createComposeCommand` emits `docker stack deploy -c … --prune
    // --with-registry-auth` for this type. There is no `--build`, and
    // `stack deploy` has no build phase, so a `build:` section is inert.
    expect(
      composeBuiltImageTags({ ...OWNER, composeType: 'stack' }, TWO_BUILDS),
    ).toEqual([]);
  });

  it('names nothing for a stack whose deploy command the operator replaced', () => {
    // `compose.command` replaces the whole `docker` subcommand
    // (`createComposeCommand`'s first branch), so neither the project name nor
    // whether a build happens at all is Cloudgate's to know. Reported here as a
    // refusal with its reason rather than guessed at.
    expect(
      composeBuiltImageTags(
        { ...OWNER, command: 'compose -p something-else up -d --build' },
        TWO_BUILDS,
      ),
    ).toEqual([]);
  });

  it('names nothing for a file it cannot read', () => {
    // A delete must not fail because a stack's file is broken — the file is
    // read for one purpose and a stack in that state has usually never built.
    expect(composeBuiltImageTags(OWNER, 'services: [oh: no: :')).toEqual([]);
    expect(composeBuiltImageTags(OWNER, '')).toEqual([]);
    expect(composeBuiltImageTags(OWNER, 'just a string')).toEqual([]);
  });
});

/**
 * The exec layer recorded as **argv on a machine**, `built-image.spec.ts`'
 * shape and for its stated reason: the words are the subject's and the quoting
 * is the transport's, so a spec that read the forwarded string would be
 * asserting `shell-quote`'s escaping of the tag's `:`.
 */
const execDouble = (
  answer: (command: string) => Promise<unknown> = () =>
    Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
) => {
  const execAsync = jest.fn((command: string) => answer(command));
  const execAsyncRemote = jest.fn((_serverId: string, command: string) =>
    answer(command),
  );
  const remoteExec = withArgvExec({ execAsync, execAsyncRemote });
  return {
    execAsync,
    issued: () =>
      remoteExec.execRemote.mock.calls.map(
        ([serverId, argv]: [string, string[]]) => ({ serverId, argv }),
      ),
    remoteExec: remoteExec as unknown as RemoteExecService,
  };
};

/** The argv every one of these removals is: four words plus the tag. */
const removal = (image: string) => ['docker', 'image', 'rm', image, '--force'];

/** The read of a tag's image id that comes before its removal. */
const idRead = (image: string) => [
  'docker',
  'image',
  'inspect',
  '--format',
  '{{.Id}}',
  image,
];

describe('reclaimComposeBuiltImages', () => {
  it('drops each tag on the stack’s own Server and reports nothing', async () => {
    const exec = execDouble();

    const unreclaimed = await reclaimComposeBuiltImages(
      exec.remoteExec,
      OWNER,
      TWO_BUILDS,
      awaitImageRelease(),
    );

    expect(unreclaimed).toEqual([]);
    // Each tag's id is read before the untag, so the image can be followed
    // once no tag is left on it (#1415); this double answers no id, so there
    // is nothing to follow.
    expect(exec.issued()).toEqual([
      { serverId: 'srv-1', argv: idRead('wp-stack-web:latest') },
      { serverId: 'srv-1', argv: removal('wp-stack-web:latest') },
      { serverId: 'srv-1', argv: idRead('wp-stack-api:latest') },
      { serverId: 'srv-1', argv: removal('wp-stack-api:latest') },
    ]);
  });

  it('reports the tags it could not drop, grouped by the machine holding them', async () => {
    const exec = execDouble(() => Promise.reject(new Error('daemon down')));

    expect(
      await reclaimComposeBuiltImages(
        exec.remoteExec,
        OWNER,
        TWO_BUILDS,
        awaitImageRelease(),
      ),
    ).toEqual([
      {
        serverId: 'srv-1',
        images: ['wp-stack-web:latest', 'wp-stack-api:latest'],
      },
    ]);
    // The first real failure ends this machine's turn — `removeImagesOn`'s
    // rule, so an unreachable Server is not multiplied by the service count.
    expect(exec.issued()).toHaveLength(1);
  });

  it('reports nothing for a stack that never built, which is the common case', async () => {
    // `imageAlreadyGone`'s reason, inherited from `removeImagesOn`: a stack
    // whose `build:` service was never deployed has no tag, `docker image rm`
    // exits non-zero for it, and without the predicate every such stack would
    // be named as a leak by every delete.
    const exec = execDouble(() =>
      Promise.reject(
        Object.assign(new Error('exit 1'), {
          stderr:
            'Error response from daemon: No such image: wp-stack-web:latest',
        }),
      ),
    );

    expect(
      await reclaimComposeBuiltImages(
        exec.remoteExec,
        OWNER,
        TWO_BUILDS,
        awaitImageRelease(),
      ),
    ).toEqual([]);
    expect(exec.issued()).toHaveLength(2);
  });

  it('asks the machine nothing when the row names no image', async () => {
    const exec = execDouble();

    expect(
      await reclaimComposeBuiltImages(
        exec.remoteExec,
        { ...OWNER, composeType: 'stack' },
        TWO_BUILDS,
        awaitImageRelease(),
      ),
    ).toEqual([]);
    expect(exec.execAsync).not.toHaveBeenCalled();
  });
});
