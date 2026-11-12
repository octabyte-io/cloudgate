import { quote } from 'shell-quote';

/**
 * The two string methods a `RemoteExecService` double in this suite stubs. Both
 * optional because a double only stubs the branch its subject takes — the
 * Traefik writer's has no local exec at all — and a missing one is better as a
 * loud `undefined` at the call than as a required property nobody reads.
 */
type StringExecDouble = {
  execAsync?: jest.Mock;
  execAsyncRemote?: jest.Mock;
};

/**
 * Adds the argv half of `RemoteExecService` to a double that stubs the string
 * half, in terms of the string half.
 *
 * A single command travels as argv — `execRemote` over SSH,
 * `execFileAsync` on the platform host — while a shell *program* still travels
 * as a string. A double that stubs only the two string methods therefore misses
 * calls it used to see, and every `toHaveBeenCalledWith` and
 * `expectQuotedInCommand` in this suite would have to be rewritten against a
 * second seam that says the same thing.
 *
 * So the fake keeps **one** seam: it words the argv exactly as the service does
 * — `shell-quote`'s `quote()`, the same call `execRemote` makes — and forwards
 * it to the mock the branch would have reached before. A spec still asks "which
 * command did this route ask for", and gets the answer in the shape it always
 * had.
 *
 * What that deliberately does *not* model is the one thing the fake cannot see:
 * locally, `execFileAsync` spawns the program itself and no shell parses the
 * joined string at all. That property belongs to the service rather than to any
 * route, and `test/remote/remote-exec.service.spec.ts` is where it is asserted —
 * including the pin that `execRemote`'s joining is `quote()` and not
 * `argv.join(' ')`. A route-level spec asserting it here would only be
 * asserting this file.
 *
 * The argv methods are `jest.Mock`s in their own right, so a spec that wants to
 * assert the argv directly — `test/settings/settings.e2e-spec.ts` does, for the
 * self-update's `docker` call — still can.
 *
 * **The two argv mocks clear themselves between tests, and a suite does not opt
 * in** (H-65). They are added *after* a suite has declared the string mocks it
 * knows about, so a `beforeEach` that names the two it wrote resets neither of
 * these, and every argv call every test in the file made stayed on the record.
 * `test/databases/postgres.e2e-spec.ts` is where that first cost something: an
 * exact-list assertion there had to open with a hand-written
 * `execMock.execFileAsync.mockClear()` and a paragraph explaining why, because
 * there was no other way to say which calls it was talking about.
 *
 * The alternative — return the two mocks in a shape suites are *told* to reset —
 * was rejected because it is the failure again. "The author must remember" is
 * exactly what produced H-65: the twenty-odd suites here already remember to
 * reset the mocks they declared, and still missed these, for the good reason
 * that they never wrote them down. A convention cannot be relied on to cover a
 * thing whose whole problem is that it is invisible at the call site.
 *
 * The hook is registered only when the double is built during the **declaration**
 * phase, which `expect.getState().currentTestName` reports as `undefined`, and
 * that condition is the claim rather than a probe for what Jest will tolerate: a
 * double built at declaration scope is shared by every test in the file and is
 * the only kind that can accumulate, while one built inside a hook or a test —
 * `test/common/service-cascade.spec.ts`, `test/realtime/local-server-setup.spec.ts`
 * and `test/settings/traefik-access-log-rotation.spec.ts` all build a fresh one
 * per test — cannot outlive the test that made it and has nothing to clear.
 * A double built in `beforeAll` *is* shared and does need the hook; there the
 * condition holds, the registration is attempted, and jest-circus refuses it
 * with `Hooks cannot be defined inside tests` — loudly, which is the right
 * answer for a call site this helper cannot serve.
 *
 * `mockClear`, never `mockReset`: the argv mocks' implementation *is* the
 * forwarding to the string half, so resetting them would leave a double that
 * silently records argv and delivers it nowhere.
 */
/**
 * A `realpath -- …` argv answered as a file system without symlinks would:
 * each path, as given, one per line. Anything else is `undefined`, and goes
 * to the string half as before.
 *
 * `PatchRepoService.catRepoFile` resolves a repo file before it `cat`s it,
 * so a link out of the clone is refused. A double has no file system
 * and so no links, and a suite's string fake answers every command it does
 * not recognise with an empty stdout, which reads as "resolves nowhere" and
 * would refuse every read. Answering it here keeps the suites' `cat` fakes and
 * their exact-call assertions describing the reads they always described;
 * whether a real link is followed is asserted against a real one, in
 * `test/patch/repo-file-symlink.spec.ts`. The call is still recorded on the
 * argv mocks.
 */
const realpathOf = (
  argv: string[],
): Promise<{ stdout: string; stderr: string }> | undefined => {
  if (argv[0] !== 'realpath' || argv[1] !== '--') return undefined;
  return Promise.resolve({
    stdout: argv
      .slice(2)
      .map((p) => `${p}\n`)
      .join(''),
    stderr: '',
  });
};

export const withArgvExec = <T extends object>(double: T) => {
  // A view rather than a constraint on `T`: constraining would make every
  // double's own properties optional at the call site, and a double may stub
  // only the branch its subject takes.
  const strings = double as StringExecDouble;
  // The forwarder **overwrites** any argv method the double declared, and a
  // double must not declare one expecting to keep it. Filling in only what was
  // missing was tried and is wrong: a spec's own `execFileAsync: jest.fn()` is a
  // bare recorder with no implementation, so the argv calls it swallows never
  // reach `execAsync`, and `settings/settings.e2e-spec.ts`'s log-rotation test —
  // which asserts `execAsync` saw `docker exec <id> kill -USR1 1`, now argv
  // — fails. Forwarding is the whole point: one seam, and a spec that
  // wants the argv itself asserts on this mock, which records the same call.
  //
  // The cost, accepted knowingly: an `execAsync` call count now includes calls
  // that arrived as argv. No spec in the suite distinguishes them today, and the
  // shape a spec should reach for if one ever needs to is this mock rather than a
  // second seam.
  const execRemote = jest.fn(
    (serverId: string, argv: string[], ...rest: unknown[]) =>
      realpathOf(argv) ??
      // `rest` is spread rather than passed as two more parameters so a call
      // that omitted `onData`/`options` reaches the string mock with the arity
      // it had before, which `toHaveBeenCalledWith(serverId, command)` counts.
      (strings.execAsyncRemote?.(serverId, quote(argv), ...rest) as unknown),
  );
  const execFileAsync = jest.fn(
    (command: string, args: string[]) =>
      realpathOf([command, ...args]) ??
      (strings.execAsync?.(quote([command, ...args])) as unknown),
  );

  // H-65. See the docblock for why this is here rather than in each suite, and
  // why a run-phase double is left alone.
  if (expect.getState().currentTestName === undefined) {
    beforeEach(() => {
      execRemote.mockClear();
      execFileAsync.mockClear();
    });
  }

  return Object.assign(double, { execRemote, execFileAsync });
};
