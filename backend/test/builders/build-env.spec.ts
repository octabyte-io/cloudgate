import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  carryBuildEnv,
  envFlagWord,
  secretFlagValue,
} from '../../src/builders/build-env';
import type { BuildCommandInput } from '../../src/builders/build-strategy';
import { dockerfileStrategy } from '../../src/builders/strategies/dockerfile.strategy';
import { herokuStrategy } from '../../src/builders/strategies/heroku.strategy';
import { nixpacksStrategy } from '../../src/builders/strategies/nixpacks.strategy';
import { paketoStrategy } from '../../src/builders/strategies/paketo.strategy';
import { railpackStrategy } from '../../src/builders/strategies/railpack.strategy';
import { staticStrategy } from '../../src/builders/strategies/static.strategy';
import { elideEncodedPayloads } from '../../src/common/logging/error-payloads';
import { RemoteExecService } from '../../src/remote/remote-exec.service';

/**
 * The never-carry change's builders half: `application.env`, `project.env`,
 * `environment.env`, `application.buildArgs` and `application.buildSecrets` used
 * to reach the build tool as *command-line arguments*, so a failed build journalled every
 * one of them in clear out of `ExecError.command`.
 *
 * The two halves of the fix are both asserted here, and neither is worth
 * anything alone: the command carries no recoverable value, **and** the value
 * still arrives at the tool. A fix that only did the first is a build that no
 * longer works.
 */
const SECRET = 'sk_live_91b3d0c6f2a84e57';
const APP_ENV = `NODE_ENV=production\nSTRIPE_KEY=${SECRET}`;

/**
 * `test/remote/exec-error-payloads.spec.ts`'s oracle, and it is here for the
 * same reason it is there: a substring search over the plaintext passes against
 * a base64 leak. Every base64-alphabet run is decoded and none may yield the
 * secret.
 */
const decodedRuns = (text: string): string[] =>
  [...text.matchAll(/[A-Za-z0-9+/]{8,}={0,2}/g)].map((match) =>
    Buffer.from(match[0], 'base64').toString('utf8'),
  );

const expectNoRecoverableSecret = (text: string, secret: string): void => {
  expect(text).not.toContain(secret);
  expect(text).not.toContain(Buffer.from(secret, 'utf-8').toString('base64'));
  for (const decoded of decodedRuns(text)) {
    expect(decoded).not.toContain(secret);
  }
};

describe('carryBuildEnv', () => {
  it('keeps the operator key and puts the value under a name of its own', () => {
    const carried = carryBuildEnv('CG_BUILD_ENV', [
      'NODE_ENV=production',
      `STRIPE_KEY=${SECRET}`,
    ]);

    expect(carried.entries).toEqual([
      { key: 'NODE_ENV', holder: 'CG_BUILD_ENV_0' },
      { key: 'STRIPE_KEY', holder: 'CG_BUILD_ENV_1' },
    ]);
    expect(carried.env).toEqual({
      CG_BUILD_ENV_0: 'production',
      CG_BUILD_ENV_1: SECRET,
    });
  });

  it('carries a key the SSH channel could not name, because the holder is the name it sends', () => {
    // dotenv admits `[\w.-]+` as a key while `RemoteExecService`'s `ENV_NAME`
    // admits `[A-Za-z_][A-Za-z0-9_]*`, so a dotted key is a legal
    // `application.env` line that could not travel under its own name.
    const carried = carryBuildEnv('CG_BUILD_ENV', [`FOO.BAR-BAZ=${SECRET}`]);

    expect(carried.entries).toEqual([
      { key: 'FOO.BAR-BAZ', holder: 'CG_BUILD_ENV_0' },
    ]);
    expect(Object.keys(carried.env)).toEqual(['CG_BUILD_ENV_0']);
    expect(/^[A-Za-z_][A-Za-z0-9_]*$/.test('CG_BUILD_ENV_0')).toBe(true);
  });

  it('keeps an empty value, which a caller that cannot use one filters on the map', () => {
    const carried = carryBuildEnv('H', ['A=', 'B=b']);

    expect(carried.entries).toEqual([
      { key: 'A', holder: 'H_0' },
      { key: 'B', holder: 'H_1' },
    ]);
    // `railpack.strategy.ts` skips an empty secret this way — off the value
    // map, which never enters a command string, rather than off the command.
    expect(carried.entries.filter((e) => carried.env[e.holder])).toEqual([
      { key: 'B', holder: 'H_1' },
    ]);
  });

  it('returns an empty environment for a build with no variables, so the transport does not change', () => {
    expect(carryBuildEnv('CG_BUILD_ENV', [])).toEqual({
      env: {},
      entries: [],
    });
  });
});

describe('envFlagWord', () => {
  it('references the value rather than carrying it', () => {
    expect(envFlagWord({ key: 'STRIPE_KEY', holder: 'CG_BUILD_ENV_1' })).toBe(
      'STRIPE_KEY"=$CG_BUILD_ENV_1"',
    );
  });

  it('quotes the operator key and still concatenates into one word', () => {
    const word = envFlagWord({ key: 'a b;c', holder: 'H_0' });

    expect(word).toBe(`'a b;c'"=$H_0"`);
    // One argument, not four — the quoted run and the expansion concatenate.
    const argv = execFileSync(
      '/bin/sh',
      ['-c', `H_0=v; printf '%s\\n' ${word}`],
      { encoding: 'utf8' },
    );
    expect(argv).toBe('a b;c=v\n');
  });
});

describe('secretFlagValue', () => {
  it('keeps the operator key as the secret id and names the variable explicitly', () => {
    expect(
      secretFlagValue({ key: 'SECRET_TOKEN', holder: 'CG_BUILD_SECRET_0' }),
    ).toBe('id=SECRET_TOKEN,env=CG_BUILD_SECRET_0');
  });
});

/**
 * The six builders that put an operator's environment on a command line.
 *
 * **Which column reaches which flag is not what the ticket said**, and the difference
 * matters for what each row has to set. The three `env` columns reach `--env`
 * in nixpacks, both `pack` builders and `railpack prepare`; in the dockerfile
 * strategy — and therefore in the static one, which delegates to it — they
 * reach no flag at all, and the flags there carry `buildArgs` (`--build-arg`)
 * and `buildSecrets` (`--secret`). `env` reaches that builder only as the body
 * of a `.env` file written through `getCreateFileCommand`, which is the error mask's
 * base64 wire shape and has been elided since; it is asserted separately below
 * rather than here.
 */
const buildersUnderTest: {
  name: string;
  input: Partial<BuildCommandInput>;
  getProgram: (input: BuildCommandInput) => { command: string };
}[] = [
  {
    name: 'nixpacks',
    input: {},
    getProgram: (i) => nixpacksStrategy.getProgram(i),
  },
  {
    name: 'heroku',
    input: {},
    getProgram: (i) => herokuStrategy.getProgram(i),
  },
  {
    name: 'paketo',
    input: {},
    getProgram: (i) => paketoStrategy.getProgram(i),
  },
  {
    name: 'railpack',
    input: {},
    getProgram: (i) => railpackStrategy.getProgram(i),
  },
  {
    name: 'dockerfile (buildArgs and buildSecrets)',
    input: { buildArgs: APP_ENV, buildSecrets: APP_ENV },
    getProgram: (i) => dockerfileStrategy.getProgram(i),
  },
  {
    name: 'static, through the dockerfile builder it delegates to',
    input: {
      buildArgs: APP_ENV,
      buildSecrets: APP_ENV,
      publishDirectory: 'dist',
      isStaticSpa: true,
    },
    getProgram: (i) => staticStrategy.getProgram(i),
  },
];

describe("carryBuildEnv, on a build's operator-authored environment", () => {
  const baseInput: BuildCommandInput = {
    appName: 'blog-app',
    buildAppDirectory: '/etc/cloudgate/applications/blog-app/code',
    buildNonce: 'nonce123456',
    env: APP_ENV,
    projectEnv: null,
    environmentEnv: null,
  };

  for (const builder of buildersUnderTest) {
    it(`is absent from the command ${builder.name} journals on a failure`, () => {
      const { command } = builder.getProgram({
        ...baseInput,
        ...builder.input,
      });

      expectNoRecoverableSecret(command, SECRET);
      // The key survives: it is not the secret, and it is the diagnosis.
      expect(command).toContain('STRIPE_KEY');
    });
  }

  it('is what the exec layer is handed instead, keyed by a name it can send', () => {
    const program = dockerfileStrategy.getProgram({
      ...baseInput,
      buildArgs: APP_ENV,
      buildSecrets: APP_ENV,
    });

    expect(Object.values(program.env)).toContain(SECRET);
    for (const name of Object.keys(program.env)) {
      expect(name).toMatch(/^CG_BUILD_(ARG|SECRET)_\d+$/);
    }
  });

  it("travels as the mask's covered file body where it is a .env and not a flag", () => {
    const { command } = dockerfileStrategy.getProgram({
      ...baseInput,
      createEnvFile: true,
    });

    // In the command as base64, which is what `getCreateFileCommand` is…
    expect(command).toContain('| base64 -d >');
    expect(decodedRuns(command).join('\n')).toContain(SECRET);
    // …and gone from every string a failed exec carries, by the elision that
    // has covered this wire shape. This is the one place a build's
    // environment is still in the command string, and it is the one place a
    // mask rather than never-carry is the answer: the bytes *are* the file.
    expectNoRecoverableSecret(elideEncodedPayloads(command), SECRET);
  });

  it('leaves a build with no variables on the transport it has always used', () => {
    const program = nixpacksStrategy.getProgram({
      ...baseInput,
      env: null,
      projectEnv: null,
      environmentEnv: null,
    });

    expect(program.env).toEqual({});
  });
});

/**
 * The other half, and the reason this file shells out.
 *
 * The word the builders now emit is `KEY"=$CG_BUILD_ENV_0"`, which is only
 * worth anything if a shell really expands it into one argument that the tool
 * receives as `KEY=<value>`. So the programs are run — on the *shipped* local
 * branch, `RemoteExecService.execAsync`, which is the branch every
 * single-server install takes — against stub executables that record their
 * argv. A regression that broke the expansion would show up as a build that no
 * longer sees its own environment, which no string assertion can catch.
 */
describe('carryBuildEnv, through the shipped exec path', () => {
  let dir: string;
  let stubs: string;
  let argvLog: string;
  const remoteExec = new RemoteExecService();

  const stub = (name: string, body: string): void => {
    const file = path.join(stubs, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudgate-build-env-'));
    stubs = path.join(dir, 'bin');
    fs.mkdirSync(stubs);
    argvLog = path.join(dir, 'argv.log');

    const record = `for a in "$@"; do printf '%s\\t%s\\n' "$(basename "$0")" "$a" >> "$CG_ARGV_LOG"; done`;
    for (const tool of ['nixpacks', 'pack', 'railpack', 'docker']) {
      stub(tool, `${record}\nexit 0`);
    }
    // `railpack.strategy.ts` bootstraps the CLI with `bash -c "$(curl …)"`;
    // a no-op body keeps the program off the network.
    stub('curl', "printf ':\\n'");
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs a strategy's program the way a single-server deploy does. */
  const run = async (program: {
    command: string;
    env: Record<string, string>;
  }): Promise<string[]> => {
    fs.writeFileSync(argvLog, '');
    await remoteExec.execAsync(program.command, {
      env: {
        ...process.env,
        ...program.env,
        CG_ARGV_LOG: argvLog,
        PATH: `${stubs}:${process.env.PATH ?? ''}`,
      },
    });
    return fs.readFileSync(argvLog, 'utf8').split('\n').filter(Boolean);
  };

  const input = (): BuildCommandInput => ({
    appName: 'blog-app',
    buildAppDirectory: dir,
    dockerfilePath: path.join(dir, 'Dockerfile'),
    buildNonce: 'nonce123456',
    env: APP_ENV,
  });

  it('receives the operator value nixpacks was given on the command line before', async () => {
    const argv = await run(nixpacksStrategy.getProgram(input()));

    expect(argv).toContain(`nixpacks\tSTRIPE_KEY=${SECRET}`);
    expect(argv).toContain('nixpacks\tNODE_ENV=production');
  });

  it('receives the operator value pack was given on the command line before', async () => {
    for (const strategy of [herokuStrategy, paketoStrategy]) {
      const argv = await run(strategy.getProgram(input()));
      expect(argv).toContain(`pack\tSTRIPE_KEY=${SECRET}`);
    }
  });

  it('receives the operator value railpack prepare was given on the command line before', async () => {
    const argv = await run(railpackStrategy.getProgram(input()));

    expect(argv).toContain(`railpack\tSTRIPE_KEY=${SECRET}`);
    // …and the secret buildx mounts keeps the operator's key as its id, so
    // `/run/secrets/STRIPE_KEY` in the build is unchanged.
    expect(argv).toContain('docker\t--secret');
    expect(
      argv.some((line) =>
        /^docker\tid=STRIPE_KEY,env=CG_BUILD_ENV_\d+$/.test(line),
      ),
    ).toBe(true);
  });

  it("receives the operator value docker build's --build-arg was given on the command line before", async () => {
    const argv = await run(
      dockerfileStrategy.getProgram({
        ...input(),
        buildArgs: APP_ENV,
        buildSecrets: APP_ENV,
      }),
    );

    expect(argv).toContain(`docker\tSTRIPE_KEY=${SECRET}`);
    expect(
      argv.some((line) =>
        /^docker\tid=STRIPE_KEY,env=CG_BUILD_SECRET_\d+$/.test(line),
      ),
    ).toBe(true);
  });

  it('reaches a buildx secret under the variable the flag names', async () => {
    // The holder has to be *exported*, not merely assigned: buildx reads it out
    // of its own process environment.
    const program = dockerfileStrategy.getProgram({
      ...input(),
      buildSecrets: APP_ENV,
    });
    const holder = Object.entries(program.env).find(
      ([, value]) => value === SECRET,
    )?.[0];
    expect(holder).toBeDefined();

    stub(
      'docker',
      `printf 'docker-saw\\t%s\\n' "$(printenv ${holder})" >> "$CG_ARGV_LOG"`,
    );
    const argv = await run(program);
    expect(argv).toContain(`docker-saw\t${SECRET}`);
  });
});
