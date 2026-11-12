import fs from 'node:fs';
import path from 'node:path';
import {
  presenceProbeCommand,
  readWorkloadPresence,
} from '../../src/common/workload-presence';
import { runProbe } from '../utils/docker-daemon-stub';

/**
 * H-95. The probe every presence read runs, executed rather than
 * pattern-matched.
 *
 * The defect this closes: all four probes were
 * `<question> >/dev/null 2>&1 && echo present || echo absent`, and the docblock
 * over the reader claimed *"only a genuinely unreachable daemon can make the
 * exec itself reject"*. `||` swallows every non-zero exit, and `Cannot connect
 * to the Docker daemon` is a non-zero exit like any other — so a dockerd that
 * was stopped, wedged or mid-restart **on a reachable Server** made the probe
 * print `absent` at exit 0. The delete then dropped the row while the workload
 * kept running, behind a bare 200 with no `orphaned` key, and per ADR-0008 the
 * containers were handed to every organization on the host as unmanaged. No
 * `PATCH`, no `?force`, no attacker: a `systemctl restart docker` during a
 * delete was the whole reproduction.
 *
 * `'unknown'` was reachable only when the **transport** failed — an unreachable
 * *Server* — which is why the three-valued type had been verified for two years
 * on the one arm that worked.
 *
 * Measured on the X-run host, docker 29.7.2, against `w02-shared-app` at `1/1`
 * that second, with `DOCKER_HOST` pointed at a closed port:
 *
 * ```
 * docker service inspect w02-shared-app >/dev/null 2>&1 && echo present || echo absent  → absent, exit 0
 * if ! docker version >/dev/null 2>&1; then echo unknown; elif docker service …          → unknown, exit 0
 * ```
 *
 * Every assertion below runs the emitted string through a real `/bin/sh`. A
 * `toBe('… && echo present || echo absent')` assertion **passed on the bug** —
 * it was in three spec files and it is the reason this needs the shell.
 */
describe('presenceProbeCommand (H-95)', () => {
  const serviceQuestion = (name: string) =>
    presenceProbeCommand({
      workloadPresent: `docker service inspect ${name} >/dev/null 2>&1`,
    });

  describe('under a real shell', () => {
    it('says present for a workload a reachable daemon knows', () => {
      const ran = runProbe(serviceQuestion('web-app'), {
        reachable: true,
        services: ['web-app'],
      });

      expect(ran.said).toBe('present');
      expect(ran.status).toBe(0);
    });

    it('says absent for a workload a reachable daemon does not know', () => {
      const ran = runProbe(serviceQuestion('web-app'), {
        reachable: true,
        services: [],
      });

      expect(ran.said).toBe('absent');
      expect(ran.status).toBe(0);
    });

    it('says unknown — not absent — when the daemon cannot be reached', () => {
      // The finding. The workload is *there*; the daemon is what is not, which
      // is a state the product must not resolve to "gone".
      const ran = runProbe(serviceQuestion('web-app'), {
        reachable: false,
        services: ['web-app'],
      });

      expect(ran.said).toBe('unknown');
      expect(ran.said).not.toBe('absent');
    });

    it('still exits 0 when it answers unknown, so the exec does not reject', () => {
      // The whole reason the answer is a token on stdout rather than an exit
      // status: `RemoteExecService` rejects on any non-zero exit, and a
      // rejection cannot say *which* thing went wrong. A non-zero `unknown`
      // would arrive as the same rejection as a dead SSH connection.
      const ran = runProbe(serviceQuestion('web-app'), { reachable: false });

      expect(ran.status).toBe(0);
    });

    it('reaches no verdict but unknown when docker is not on the PATH at all', () => {
      // 127 rather than 1, and a different stderr — a case the `||` shape also
      // read as `absent`.
      const ran = runProbe(
        'if ! docker-that-is-not-installed version >/dev/null 2>&1; then echo unknown; elif true; then echo present; else echo absent; fi',
        { reachable: true },
      );

      expect(ran.said).toBe('unknown');
    });
  });

  describe('the shape itself', () => {
    it('never collapses the daemon question into the workload question', () => {
      const command = serviceQuestion('web-app');

      // `|| true` and `|| echo absent` are the two ways this has been got
      // wrong; both make a failure answer for the product.
      expect(command).not.toContain('|| true');
      expect(command).not.toContain('|| echo absent');
      // Three branches, three tokens, and the token that lets a row be dropped
      // is reached only after the daemon has positively answered.
      expect(command.indexOf('echo unknown')).toBeLessThan(
        command.indexOf('echo absent'),
      );
    });

    it('asks the daemon whether it is there before asking it about the workload', () => {
      const command = serviceQuestion('web-app');

      // `toContain` first, and not only the ordering: `indexOf` of a substring
      // that is not present is -1, which is less than everything, so an
      // ordering assertion on its own is satisfied by a command that never asks
      // the daemon at all — i.e. by the H-95 defect.
      expect(command).toContain('docker version');
      expect(command.indexOf('docker version')).toBeLessThan(
        command.indexOf('docker service inspect'),
      );
    });

    it('lets the caller run the daemon check in the same environment as its question', () => {
      // The compose project half runs under `env -i`, which strips
      // `DOCKER_HOST` — so a bare `docker version` there would answer for a
      // daemon the question is not asking. Measured on the host with
      // `DOCKER_HOST=tcp://127.0.0.1:1`: `docker compose … ps -q` failed while
      // `env -i PATH="$PATH" docker compose … ps -q` returned the live id.
      expect(
        presenceProbeCommand({
          daemonReachable: 'env -i PATH="$PATH" docker version >/dev/null 2>&1',
          workloadPresent: 'true',
        }),
      ).toContain('env -i PATH="$PATH" docker version');
    });
  });
});

/**
 * The verdict half. Its mapping was never what broke — which is the point worth
 * keeping: a full unit spec of this function was green throughout H-95, because
 * the wrong answer was manufactured in the shell and arrived here as a
 * perfectly well-formed `absent`.
 */
describe('readWorkloadPresence', () => {
  it('reads a deliberate unknown token as unknown', async () => {
    // Not via the "anything else" arm. That arm documents a *shell that never
    // ran the command* — a banner, an empty answer — and a later reader is
    // entitled to narrow it. The probe now emits `unknown` on purpose, so the
    // token is matched on purpose (H-95).
    expect(await readWorkloadPresence(() => Promise.resolve('unknown\n'))).toBe(
      'unknown',
    );
  });

  it('still reads the two positive answers', async () => {
    expect(await readWorkloadPresence(() => Promise.resolve('present\n'))).toBe(
      'present',
    );
    expect(await readWorkloadPresence(() => Promise.resolve('absent\n'))).toBe(
      'absent',
    );
  });

  it('still reads a rejected exec as unknown', async () => {
    // The transport, which is the only thing that can still reject: SSH
    // refused, no route to the Server.
    expect(
      await readWorkloadPresence(() =>
        Promise.reject(new Error('ssh: connect ECONNREFUSED')),
      ),
    ).toBe('unknown');
  });

  it('still reads an answer that is not an answer as unknown', async () => {
    expect(
      await readWorkloadPresence(() =>
        Promise.resolve('Welcome to Ubuntu 24.04.4 LTS\n'),
      ),
    ).toBe('unknown');
  });
});

/**
 * The set-level guard, and the reason it exists rather than an eleventh
 * per-suite assertion (H-104).
 *
 * **What went wrong.** H-95 changed the probe's shape —
 * `<question> >/dev/null 2>&1 && echo present || echo absent` became
 * `if ! <daemon>; then echo unknown; elif <question>; …` — and updated the four
 * builders and their unit specs. It did not update the **ten** hand-written
 * copies of that string in `backend/test`, which exist on purpose: a suite that
 * imported the builder would agree with whatever the builder said, and the shell
 * trick the whole three-valued read depends on (exit 0 either way, the answer on
 * stdout) is exactly what a "simplification" would quietly drop.
 *
 * Nine of those copies were *discriminators* — `command.startsWith('docker
 * service inspect ')`, `command.endsWith('&& echo present || echo absent')` —
 * inside the default exec mock of an e2e suite. Once the probe no longer matched
 * one, the command fell through to the mock's default, the probe answered `''`,
 * {@link readWorkloadPresence} read that as `'unknown'`, and **every delete in
 * that suite 409'd**: 21 tests across 9 suites, deterministically red on `main`
 * from `84a1dcb` until this run. `84a1dcb`'s own commit message records noticing
 * the failure mode in one file and repairing it there.
 *
 * **Why the copy is still a copy, and why there is now one.** The property is
 * worth keeping; what was missing was a way to be *told* when a copy goes
 * stale. So this asserts the set rather than the members, in
 * `container-logs.spec.ts`'s shape and for its stated reason — there is no
 * eslint rule that can see across a mock's discriminator and the shell program
 * it is meant to recognise. Independence from `src` is what the ten copies were
 * for, and one copy preserves it exactly, so they were consolidated them into
 * `test/utils/workload-presence-probe.ts` — hand-written, importing nothing
 * from `src`, and the only site left besides this file's own executed
 * fixtures. The set below is what keeps that true: an eleventh copy anywhere
 * under `backend/test` fails here rather than nine suites a wave later.
 *
 * **The rule, and it is one rule twice.** A hand-written probe must be in the
 * shape {@link presenceProbeCommand} currently emits, and a hand-written
 * discriminator must **recognise** a probe that shape can produce. The expected
 * shape is derived from the builder here rather than restated, so changing the
 * builder changes what this test demands and every stale copy in the tree goes
 * red in one run.
 *
 * Prose is excluded by line, not by hope: this file, `docker-daemon-stub.ts`,
 * `workload-presence-probe.ts` and every suite that records why its copy went
 * stale quote the pre-H-95 shape in docblocks on purpose, and a docblock
 * discriminates nothing.
 */
describe('backend/test', () => {
  const testRoot = path.resolve(__dirname, '..');

  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });

  /**
   * The builder's shape as a pattern, with its two questions punched out. A
   * literal regex here would be a second statement of the shape, and it could
   * go stale exactly the way the ten copies did.
   */
  const HOLE = '\u0000';
  const shapePattern = new RegExp(
    presenceProbeCommand({ daemonReachable: HOLE, workloadPresent: HOLE })
      .split(HOLE)
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('(.+?)'),
  );

  const isProse = (line: string): boolean => {
    const trimmed = line.trim();
    return (
      trimmed.startsWith('*') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*')
    );
  };

  const sources = walk(testRoot).map((file) => ({
    file: path.relative(testRoot, file),
    lines: fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => !isProse(line)),
  }));

  /**
   * What a line that writes a *whole* probe out looks like, in either the
   * pre-H-95 shape or this one. Both answers are required, because a line
   * naming only one of them is a partial assertion
   * (`toContain('then echo present')`) rather than a copy of the program; and
   * the `then`/`&&` before the first answer is required so that this scanner's
   * own predicates are not mistaken for probes. A third shape nobody has
   * written yet would drop out of the enumeration below rather than pass here
   * silently — which is what that list is for.
   */
  const WHOLE_PROBE = /(then|&&) echo present[\s\S]*echo absent/;

  /** Every line that writes a whole probe out. */
  const probeCopies = sources.flatMap(({ file, lines }) =>
    lines
      .filter((line) => WHOLE_PROBE.test(line))
      .map((line) => {
        const found = shapePattern.exec(line);
        return {
          file,
          agrees: found !== null,
          // `${appName}` and friends are holes too: what is compared is the
          // program, not the name it happens to ask about.
          probe: found ? found[0].replace(/\$\{[^}]*\}/g, HOLE) : line.trim(),
        };
      }),
  );

  /**
   * Every probe the tree says the product issues, plus the swarm-service
   * question — the one no module exports as a builder, so its witness is
   * written out here, once, in the file that owns the contract.
   */
  const witnessesFor = (name: string): string[] =>
    [
      ...probeCopies.filter((copy) => copy.agrees).map((copy) => copy.probe),
      presenceProbeCommand({
        workloadPresent: `docker service inspect ${HOLE} >/dev/null 2>&1`,
      }),
    ].map((template) => template.split(HOLE).join(name));

  const PREDICATE = /\.(startsWith|endsWith)\(\s*(?:`([^`]*)`|'([^']*)')\s*\)/g;
  const QUESTION = /docker (service inspect|stack ps|compose -p)/;
  const TOKEN = /echo (present|absent|unknown)/;
  /** A quoted answer nearby is what makes a `startsWith` a *presence* probe's. */
  const ANSWER = /'(present|absent|unknown)/;

  const discriminators = sources.flatMap(({ file, lines }) =>
    lines.flatMap((line, index) =>
      [...line.matchAll(PREDICATE)].flatMap((match) => {
        const literal = match[2] ?? match[3];
        const window = lines
          .slice(Math.max(0, index - 4), index + 5)
          .join('\n');
        if (
          !TOKEN.test(literal) &&
          !(QUESTION.test(literal) && ANSWER.test(window))
        ) {
          return [];
        }
        // The name a discriminator may be pinning, tried against every
        // witness: `startsWith('docker service inspect main-db')` is stale
        // whatever the name, and this makes that the reason it fails.
        const names = ['appname', ...(literal.match(/[A-Za-z0-9_-]+/g) ?? [])];
        const recognises = names.some((name) =>
          witnessesFor(name).some((probe) =>
            match[1] === 'startsWith'
              ? probe.startsWith(literal)
              : probe.endsWith(literal),
          ),
        );
        return [{ file, literal, recognises }];
      }),
    ),
  );

  it('finds every file that hand-writes the probe or a discriminator for it', () => {
    // Listing the current set as the expected value is the point: a *third*
    // file is a failure here rather than nine red suites a wave later. There
    // were sixteen until the fix consolidated the ten copies into
    // `utils/workload-presence-probe.ts`; the two that remain are that helper
    // and this file, whose own copy is the executed fixture two `describe`s up
    // (the `docker-that-is-not-installed` probe, which has to be written out
    // because the point of it is a program the builder would never emit). When
    // a site is added legitimately, add it to this list — and when one stops
    // needing a copy, take it out.
    expect(
      [
        ...new Set(
          [...probeCopies, ...discriminators].map((site) => site.file),
        ),
      ].sort(),
    ).toEqual([
      'common/workload-presence.spec.ts',
      'utils/workload-presence-probe.ts',
    ]);
  });

  it('keeps every hand-written probe in the shape the builder emits', () => {
    expect(probeCopies.filter((copy) => !copy.agrees)).toEqual([]);
  });

  it('leaves no discriminator that recognises no probe the product can issue', () => {
    // This is the assertion that was missing. A discriminator matching nothing
    // does not fail loudly: the command falls through to the mock's default, the
    // probe answers `''`, and the suite reads that as `'unknown'` — so the
    // delete refuses and the failure looks like a product bug (H-104).
    expect(discriminators.filter((site) => !site.recognises)).toEqual([]);
  });
});
