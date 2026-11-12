import { scheduleTypeEnum } from '../../src/scheduling/schedules/schedule.schema';
import {
  CONTAINER_SCHEDULE_TYPES,
  createScheduleSchema,
  HOST_SCHEDULE_TYPES,
  INERT_COMMAND_REFUSAL,
  scheduleRunsACommand,
  scheduleRunsAScript,
} from '../../src/scheduling/schedules/dto/schedule.dto';

/**
 * The exact mirror of the inert `script` refused earlier, and the
 * half that fix left for a stated reason.
 *
 * `SchedulesService.buildRunScript` never reads `command` for `server` or
 * `cloudgate-server`: those two materialize a `script.sh` and run *that*, so a
 * `command` on one of them was stored and never executed. The earlier fix declined to
 * refuse it because `command` was `.default('')` against a `notNull` column, so
 * the DTO manufactured a value for **every** request and a refusal could not
 * tell a client's value from zod's.
 *
 * **The default goes, which is what makes the refusal possible.** Absent now
 * means absent, exactly as `script`'s `.optional()` already did, and the `''`
 * the `notNull` column needs is supplied by `SchedulesService.create` —
 * *behind* the refusal rather than inside the validation that has to see
 * through it. That is the whole trick: the manufacture did not go away, it
 * moved to where it stops lying to the guard. `scheduleId` and `appName` are
 * already minted there for a related reason.
 *
 * **Two of the three candidate answers were rejected.** Dropping `notNull` from
 * the column would make `command` nullable on the wire and give every reader a
 * third state — `null`, `''` and a value — to mean the same thing, for a column
 * whose empty string already reads back as `''` (`encryptValue` short-circuits
 * a falsy value, which is why the column has no default and needs none).
 * Documenting the field as inert was the earlier answer and is what this ticket
 * reopens: a field an operator can set, that is persisted, that appears in
 * `GET /schedules/:id`, and that nothing ever runs is not made safe by a
 * docblock the operator never reads.
 *
 * **Where it differs from `script`'s rule, deliberately: `''` is admitted.**
 * `script`'s refusal is on the *presence* of the key, `''` included, on the
 * reasoning that a client told the field exists for empty values has been told
 * the field exists. `command` cannot take that rule, and not for want of
 * symmetry: `''` is the column's own resting value, so refusing it would refuse
 * the very byte the row is about to hold, refuse every existing fixture and
 * client that spells the empty command out, and — on `PATCH` — refuse the write
 * that *clears* an inert command a row already holds, which is the remediation
 * `refuseInertScript` admits `null` for. So what is refused is a **non-empty**
 * `command` where nothing runs it.
 */

describe('scheduleRunsACommand', () => {
  /**
   * The ticket asks whether this and {@link scheduleRunsAScript} are one
   * question or two. **One**, and the single statement of it is the pair of
   * tuples: both predicates read that pair, and neither reads the other.
   *
   * Defining this one as `!scheduleRunsAScript` was the tempting spelling and
   * is worse in the only case that distinguishes them. A fifth `scheduleType`
   * that fell into neither tuple would answer *"runs a command"* under the
   * negation — accepting a `command` nothing runs, which is the defect back
   * again — and *"runs neither"* under the membership test, which refuses both
   * fields and cannot be silent. `schedule-inert-script.spec.ts`' partition
   * assertion is what stops a fifth type reaching either, and this is what it
   * costs if it ever fails.
   */
  it('answers the complement of scheduleRunsAScript for every schedule type', () => {
    expect(
      Object.fromEntries(
        scheduleTypeEnum.enumValues.map((type) => [
          type,
          scheduleRunsACommand(type),
        ]),
      ),
    ).toEqual({
      application: true,
      compose: true,
      server: false,
      'cloudgate-server': false,
    });

    // Complementary today, and read off the enum rather than off either tuple,
    // so this is the classification being asserted rather than its spelling.
    for (const type of scheduleTypeEnum.enumValues) {
      expect(scheduleRunsACommand(type)).toBe(!scheduleRunsAScript(type));
    }
  });
});

describe('createScheduleSchema', () => {
  const hostSchedule = (extra: Record<string, unknown>) => ({
    name: 'Update packages',
    cronExpression: '0 6 * * *',
    serviceId: 'server-1',
    ...extra,
  });

  it('no longer manufactures a command for a request that sent none', () => {
    // The change that makes a refusal possible at all. Before this, every
    // parsed body carried `command: ''` whether the client wrote one or not,
    // so the guard below could not have existed.
    const parsed = createScheduleSchema.parse(
      hostSchedule({ scheduleType: 'server', script: 'apt update' }),
    );

    expect(parsed.command).toBeUndefined();
    expect('command' in parsed).toBe(false);
  });

  for (const scheduleType of HOST_SCHEDULE_TYPES) {
    it(`refuses a command on a ${scheduleType} schedule, naming the field`, () => {
      const result = createScheduleSchema.safeParse(
        hostSchedule({ scheduleType, command: 'pg_dump cloudgate' }),
      );

      expect(result.success).toBe(false);
      expect(
        result.error?.issues.map((issue) => [
          issue.path.join('.'),
          issue.message,
        ]),
      ).toEqual([['command', INERT_COMMAND_REFUSAL]]);
    });

    it(`takes an empty command on a ${scheduleType} schedule`, () => {
      // The asymmetry with `script`, and the reason for it: `''` is what the
      // `notNull` column holds for these two types, so refusing it would refuse
      // the row's own resting value and every fixture that spells it out.
      const result = createScheduleSchema.safeParse(
        hostSchedule({ scheduleType, command: '' }),
      );

      expect(result.success).toBe(true);
      expect(result.data?.command).toBe('');
    });

    it(`takes a ${scheduleType} schedule that names no command`, () => {
      expect(
        createScheduleSchema.safeParse(hostSchedule({ scheduleType })).success,
      ).toBe(true);
    });
  }

  for (const scheduleType of CONTAINER_SCHEDULE_TYPES) {
    it(`keeps taking a command on a ${scheduleType} schedule`, () => {
      const result = createScheduleSchema.safeParse(
        hostSchedule({ scheduleType, command: 'rm -rf /tmp/cache' }),
      );

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({
        scheduleType,
        command: 'rm -rf /tmp/cache',
      });
    });
  }

  it('reads an absent scheduleType as application, so a command is still taken', () => {
    // The published contract's default, on the path where it decides a
    // refusal. `scheduleType` stays optional — the property the earlier fix measured a
    // `z.discriminatedUnion` would have cost — so an omitted one is an
    // application schedule, and an application schedule runs its command.
    const result = createScheduleSchema.safeParse(
      hostSchedule({ command: 'rm -rf /tmp/cache' }),
    );

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ scheduleType: 'application' });
  });

  it('names both fields when a host schedule carries a command and a container one a script', () => {
    // Two refinements over one object, so a body that is wrong twice is told
    // so twice rather than being fixed one round trip at a time.
    const result = createScheduleSchema.safeParse(
      hostSchedule({
        scheduleType: 'application',
        command: 'rm -rf /tmp/cache',
        script: 'apt update',
      }),
    );

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toEqual([
      'script',
    ]);
  });
});
