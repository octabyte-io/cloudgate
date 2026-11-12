import { BadRequestException } from '@nestjs/common';
import {
  calculateResources,
  encodeBase64,
  generateBindMounts,
  generateFileMounts,
  generateVolumeMounts,
  getCreateFileCommand,
  prepareEnvironmentVariables,
  resolveShellSafePath,
} from '../../src/docker/docker.utils';
import type { ServiceMount } from '../../src/docker/docker.types';

describe('prepareEnvironmentVariables', () => {
  it('turns a dotenv-style string into KEY=VALUE pairs', () => {
    const env = 'DATABASE_URL=postgres://localhost:5432/app\nPORT=3000';

    expect(prepareEnvironmentVariables(env)).toEqual([
      'DATABASE_URL=postgres://localhost:5432/app',
      'PORT=3000',
    ]);
  });

  it('resolves ${{project.*}}, ${{environment.*}} and self references', () => {
    const projectEnv = 'DB_HOST=db.internal';
    const environmentEnv = 'DB_NAME=app_staging';
    const serviceEnv = [
      'DB_USER=app',
      'DATABASE_URL=postgres://${{DB_USER}}@${{project.DB_HOST}}/${{environment.DB_NAME}}',
    ].join('\n');

    expect(
      prepareEnvironmentVariables(serviceEnv, projectEnv, environmentEnv),
    ).toEqual([
      'DB_USER=app',
      'DATABASE_URL=postgres://app@db.internal/app_staging',
    ]);
  });

  describe('wired variables (ADR-0031)', () => {
    const wired = { DATABASE_URL: 'postgresql://u:p@postgres-abc:5432/db' };

    it('adds each wired value beside the typed ones', () => {
      expect(
        prepareEnvironmentVariables('NODE_ENV=production', '', '', wired),
      ).toEqual([
        'NODE_ENV=production',
        'DATABASE_URL=postgresql://u:p@postgres-abc:5432/db',
      ]);
    });

    it('lets a typed variable name a wired one as a sibling', () => {
      expect(
        prepareEnvironmentVariables(
          'PRISMA_URL=${{DATABASE_URL}}',
          '',
          '',
          wired,
        ),
      ).toEqual([
        'PRISMA_URL=postgresql://u:p@postgres-abc:5432/db',
        'DATABASE_URL=postgresql://u:p@postgres-abc:5432/db',
      ]);
    });

    it('keeps a typed value of the same name over the wired one', () => {
      expect(
        prepareEnvironmentVariables('DATABASE_URL=sqlite://x', '', '', wired),
      ).toEqual(['DATABASE_URL=sqlite://x']);
    });
  });

  it('throws when a reference points at a variable that does not exist', () => {
    expect(() =>
      prepareEnvironmentVariables('URL=${{project.MISSING}}', '', ''),
    ).toThrow(/project\.MISSING/);
  });

  // The deploy log's only explanation was `Invalid environment variable:
  // environment.UI_NOPE`, which said "invalid" for "not set" and named neither
  // the variable holding the reference nor where it was looked up.
  it.each([
    [
      'project',
      'X=${{project.UI_NOPE}}',
      'X refers to ${{project.UI_NOPE}}, but UI_NOPE is not set on the Project. Set it on the Project, or change the reference.',
    ],
    [
      'environment',
      'X=${{environment.UI_NOPE}}',
      'X refers to ${{environment.UI_NOPE}}, but UI_NOPE is not set on the Environment. Set it on the Environment, or change the reference.',
    ],
    [
      'own',
      'X=${{UI_NOPE}}',
      'X refers to ${{UI_NOPE}}, but UI_NOPE is not set beside it. Add UI_NOPE to these variables, or change the reference.',
    ],
  ])(
    'names the referencing key, the scope and "not set" for a missing %s reference',
    (_scope, serviceEnv, message) => {
      expect(() =>
        prepareEnvironmentVariables(
          serviceEnv,
          'UI_PROJECT_VAR=p',
          'UI_ENV_VAR=e',
        ),
      ).toThrow(new Error(message));
    },
  );
});

describe('generateVolumeMounts', () => {
  it('maps volume-type mounts to dockerode volume specs, ignoring others', () => {
    const mounts: ServiceMount[] = [
      {
        type: 'volume',
        volumeName: 'pg-data',
        mountPath: '/var/lib/postgresql/data',
      },
      { type: 'bind', hostPath: '/srv/uploads', mountPath: '/app/uploads' },
    ];

    expect(generateVolumeMounts(mounts)).toEqual([
      {
        Type: 'volume',
        Source: 'pg-data',
        Target: '/var/lib/postgresql/data',
      },
    ]);
  });

  it('returns an empty array when there are no mounts', () => {
    expect(generateVolumeMounts([])).toEqual([]);
  });
});

describe('generateBindMounts', () => {
  it('maps bind-type mounts to dockerode bind specs, ignoring others', () => {
    const mounts: ServiceMount[] = [
      { type: 'volume', volumeName: 'pg-data', mountPath: '/data' },
      { type: 'bind', hostPath: '/srv/uploads', mountPath: '/app/uploads' },
    ];

    expect(generateBindMounts(mounts)).toEqual([
      {
        Type: 'bind',
        Source: '/srv/uploads',
        Target: '/app/uploads',
      },
    ]);
  });
});

describe('generateFileMounts', () => {
  it('binds each file-type mount from the app files directory', () => {
    const mounts: ServiceMount[] = [
      { type: 'file', filePath: 'config.json', mountPath: '/app/config.json' },
      { type: 'bind', hostPath: '/srv', mountPath: '/srv' },
    ];

    expect(
      generateFileMounts(mounts, '/etc/cloudgate/applications/my-app/files'),
    ).toEqual([
      {
        Type: 'bind',
        Source: '/etc/cloudgate/applications/my-app/files/config.json',
        Target: '/app/config.json',
      },
    ]);
  });

  /**
   * `Target` is `mountPath` verbatim, never `mountPath/filePath`.
   *
   * The case above cannot tell the two apart — its mount path already ends in
   * the file name — so this one uses a directory-shaped mount path, the shape
   * an operator typed when the form said the file was "written inside the
   * mount path". The console now says the mount path is the file's own full
   * path; this pins the backend to the same meaning, because every stored file
   * mount (application and database alike, both through this function) was
   * written to it, and joining the two would move each file on its next
   * Deployment.
   */
  it('binds the file onto the mount path itself, not under it', () => {
    const mounts: ServiceMount[] = [
      { type: 'file', filePath: 'app.conf', mountPath: '/etc/ui' },
    ];

    expect(
      generateFileMounts(mounts, '/etc/cloudgate/applications/my-app/files'),
    ).toEqual([
      {
        Type: 'bind',
        Source: '/etc/cloudgate/applications/my-app/files/app.conf',
        Target: '/etc/ui',
      },
    ]);
  });
});

describe('calculateResources', () => {
  it('turns string limits/reservations into byte and nano-CPU numbers', () => {
    // 256 MiB memory limit, 1 CPU (docker expects nano-CPUs: 1e9 per core)
    expect(
      calculateResources({
        memoryLimit: '268435456',
        memoryReservation: '134217728',
        cpuLimit: '1000000000',
        cpuReservation: '500000000',
      }),
    ).toEqual({
      Limits: { MemoryBytes: 268435456, NanoCPUs: 1000000000 },
      Reservations: { MemoryBytes: 134217728, NanoCPUs: 500000000 },
    });
  });

  it('leaves unset fields undefined so docker applies no constraint', () => {
    expect(
      calculateResources({
        memoryLimit: null,
        memoryReservation: null,
        cpuLimit: null,
        cpuReservation: null,
      }),
    ).toEqual({
      Limits: { MemoryBytes: undefined, NanoCPUs: undefined },
      Reservations: { MemoryBytes: undefined, NanoCPUs: undefined },
    });
  });

  /**
   * H-59. A non-numeric limit such as `"lots"` made `Number.parseInt` return
   * `NaN`, and `MemoryBytes: NaN` reached `createService` — which accepts it and
   * fails the service at converge time, not at the API. An unparseable limit
   * now takes the same "no constraint" shape an absent one does, so the fault,
   * if any, surfaces as a rejected write rather than a stuck deploy.
   *
   * The inputs start with no digit on purpose: `Number.parseInt` is lenient and
   * reads `"512mb"` as `512`, so only a leading-non-digit value ever reached
   * `NaN` — which is exactly the shape this guard is for.
   */
  it('treats an unparseable limit as no constraint rather than passing NaN', () => {
    expect(
      calculateResources({
        memoryLimit: 'lots',
        memoryReservation: 'plenty',
        cpuLimit: 'one',
        cpuReservation: 'half',
      }),
    ).toEqual({
      Limits: { MemoryBytes: undefined, NanoCPUs: undefined },
      Reservations: { MemoryBytes: undefined, NanoCPUs: undefined },
    });
  });
});

describe('encodeBase64', () => {
  it('encodes utf-8 content to base64', () => {
    expect(encodeBase64('hello cloudgate')).toBe('aGVsbG8gY2xvdWRnYXRl');
  });
});

/**
 * The joined path reaches two `mkdir -p` words, and the command goes to
 * `RemoteExecService`. Those words were bare when the shell-safety fix first landed, which
 * is what reopened it — so these assert two different things on purpose. The
 * *refusal* cases stay refusals, and pin no escaping scheme. The *quoting*
 * cases pin the one property the refusal cannot supply: the joined path is one
 * double-quoted word, so a character the refusal does not carry — `;` above
 * all — is a filename rather than a second command.
 */
describe('getCreateFileCommand', () => {
  const filesDirectory = '/etc/cloudgate/applications/blog-app/files';

  it('builds the write for a legitimate path', () => {
    expect(
      getCreateFileCommand(filesDirectory, 'files/config/app.yml', 'debug: no'),
    ).toBe(
      `mkdir -p "${filesDirectory}/files/config";\n` +
        `echo "${encodeBase64('debug: no')}" | base64 -d > "${filesDirectory}/files/config/app.yml";\n`,
    );
  });

  it('builds the mkdir for a legitimate directory path', () => {
    // path.join keeps the trailing slash, and so does the emitted word.
    expect(getCreateFileCommand(filesDirectory, 'seed/', '')).toBe(
      `mkdir -p "${filesDirectory}/seed/";\n`,
    );
  });

  /** Every `"…"` in the emitted command, quotes stripped. */
  const shellWordsOf = (command: string): string[] =>
    [...command.matchAll(/"([^"]*)"/g)].map((match) => match[1]);

  /**
   * The reopening of the shell-safety fix. `SHELL_UNSAFE` is the set that escapes a
   * *double-quoted* word, and for a while it was the whole defence over two
   * *unquoted* ones — so `POST /mounts` with
   * `filePath="x;touch /root/cg-x/pwn/x04-3.flag #/"` answered 201 and created
   * the flag as root on the build server, while `a$(id)/` on the same route in
   * the same minute answered 400.
   *
   * These are the only tests in this file that read the emitted string, and
   * they do it because the refusal genuinely cannot see these payloads: `;`
   * `&` `|` `(` `)` `>` `<` and whitespace are all legal filename characters,
   * so widening the shared set to cover them is the fix that was rejected.
   * What they assert is that the joined path is **one word**, which is the
   * property the refusal cannot supply and quoting is there for.
   */
  describe('a metacharacter the refusal does not carry', () => {
    it('keeps a statement separator in one word on the trailing-slash branch', () => {
      const payload = 'x;touch /tmp/flag #/';

      const command = getCreateFileCommand(filesDirectory, payload, '');

      expect(command).toBe(
        `mkdir -p "${filesDirectory}/x;touch /tmp/flag #/";\n`,
      );
      // Nothing after the `;` is a command — it is all one filename.
      expect(shellWordsOf(command)).toEqual([
        `${filesDirectory}/x;touch /tmp/flag #/`,
      ]);
      // Nothing was left bare on the way to being quoted.
      expect(command).not.toContain('mkdir -p /etc');
    });

    it('keeps a statement separator in one word on the dirname branch', () => {
      // The directory-form variant: the payload lands in `dirname`, which is
      // the word the write branch interpolates beside its quoted redirect.
      const payload = 'x;touch /tmp/flag #/app.yml';

      const command = getCreateFileCommand(
        filesDirectory,
        payload,
        'debug: no',
      );

      expect(command).toBe(
        `mkdir -p "${filesDirectory}/x;touch /tmp/flag #";\n` +
          `echo "${encodeBase64('debug: no')}" | base64 -d > "${filesDirectory}/x;touch /tmp/flag #/app.yml";\n`,
      );
      expect(command).not.toContain('mkdir -p /etc');
    });

    it('keeps every separator, pipeline, subshell and redirect in one word', () => {
      // Each of these ends a command, starts a pipeline, opens a subshell or
      // redirects in a bare word, and each is an ordinary filename character
      // inside quotes — which is why `SHELL_UNSAFE` deliberately omits them.
      for (const payload of [
        'a;id/',
        'a&id/',
        'a|id/',
        'a(id)/',
        'a id/',
        'a>out/',
        'a<in/',
        'a\tid/',
      ]) {
        const command = getCreateFileCommand(filesDirectory, payload, '');

        expect(shellWordsOf(command)).toEqual([`${filesDirectory}/${payload}`]);
      }
    });
  });

  it('refuses a command substitution on the trailing-slash branch', () => {
    // The branch that interpolated the whole joined path unquoted.
    expect(() => getCreateFileCommand(filesDirectory, 'a$(id)/', '')).toThrow(
      BadRequestException,
    );
    expect(() =>
      getCreateFileCommand(filesDirectory, 'a`whoami`/', ''),
    ).toThrow(BadRequestException);
  });

  it('refuses a command substitution on the dirname branch', () => {
    // The branch that interpolated the joined path's dirname unquoted; the
    // redirect target beside it was already quoted, which is why only these
    // two were reachable.
    expect(() =>
      getCreateFileCommand(filesDirectory, 'a$(id)/config.json', 'x'),
    ).toThrow(BadRequestException);
    expect(() =>
      getCreateFileCommand(filesDirectory, 'a`whoami`/config.json', 'x'),
    ).toThrow(BadRequestException);
  });

  it('refuses a metacharacter in the file segment too', () => {
    // dirname() would have dropped it, but the quoted redirect target keeps it
    // — and `"` closes that quote, so the check is on the whole path.
    for (const filePath of [
      'config$(id).json',
      'config`id`.json',
      'config".json',
      'config\\.json',
      'config\n.json',
      'config\r.json',
    ]) {
      expect(() => getCreateFileCommand(filesDirectory, filePath, 'x')).toThrow(
        BadRequestException,
      );
    }
  });

  it('refuses a metacharacter that arrives in the output path', () => {
    // `outputPath` lands in the same shell word as `filePath`, and the builder
    // strategies derive theirs from a caller-supplied dockerfile path.
    expect(() =>
      getCreateFileCommand('/apps/a$(id)/code', '.env', 'PORT=3000'),
    ).toThrow(BadRequestException);
  });

  it('leaves content alone, which base64 already carries through the shell', () => {
    const command = getCreateFileCommand(
      filesDirectory,
      'config.json',
      '{"cmd":"$(id)`whoami`"}',
    );
    expect(command).toContain(encodeBase64('{"cmd":"$(id)`whoami`"}'));
    expect(command).not.toContain('$(id)');
  });
});

describe('resolveShellSafePath', () => {
  it('returns the joined path when nothing can escape the shell word', () => {
    expect(resolveShellSafePath('/etc/cloudgate/schedules', 'run.sh')).toBe(
      '/etc/cloudgate/schedules/run.sh',
    );
  });

  it('answers a 400 rather than a 500, so a bad path reads as the caller error it is', () => {
    // §2.5: a Nest built-in, not a custom class — patch-repo.service.ts's
    // resolveRepoFilePath is the same util-throwing-BadRequestException shape.
    expect(() => resolveShellSafePath('/etc/cloudgate', 'a$(id)')).toThrow(
      new BadRequestException('Invalid path'),
    );
  });
});
