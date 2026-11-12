import { scheduleTypeEnum } from '../../src/scheduling/schedules/schedule.schema';
import {
  CONTAINER_SCHEDULE_TYPES,
  createScheduleSchema,
  HOST_SCHEDULE_TYPES,
  INERT_SCRIPT_REFUSAL,
  scheduleRunsAScript,
  updateScheduleSchema,
} from '../../src/scheduling/schedules/dto/schedule.dto';

/**
 * `POST /schedules` accepted a `script` for every `scheduleType`,
 * and `SchedulesService.materializeScript` returns early for `application` and
 * `compose` — so a container schedule took a script body, persisted it
 * (encrypted,) and never materialized it. A silent no-op field on
 * two of the four types, and since the at-rest change a silent no-op field holding an
 * operator's credentials.
 *
 * This is the parent change's problem — *"the type permits what the code does not"* — and
 * deliberately **not** that change's shape. `createScheduleSchema`'s docblock carries
 * the measurements; the short version is that a `z.discriminatedUnion` cannot
 * be a DTO here at all (nestjs-zod types the base constructor as the schema's
 * parse output, so a union output is TS2509), and that the union's only
 * remaining benefit over a refinement was the compile-time one TS2509 denies:
 * a `z.object` arm without a `script` key refuses **nothing**, because zod
 * strips unknown keys, so the runtime refusal has to be an explicit member
 * either way. What this file pins is the behaviour both shapes would have had,
 * and the three things that had to survive the change:
 *
 * - **the sentence, at the field path.** A plain `z.union` — the shape that
 *   needs no `z.preprocess` — collapses every refusal to `invalid_union` /
 *   *"Invalid input"* at path `[]`, measured, which is precisely what the
 *   ticket asked not to ship.
 * - **`scheduleType` staying optional.** It is `default: application` in the
 *   published `openapi.json`, and a discriminated union refuses an absent
 *   discriminator outright.
 * - **one classification, not two.** {@link scheduleRunsAScript} is what the
 *   refusal here, `SchedulesService.update`'s guard and
 *   `SchedulesService.materializeScript`'s early return all branch on. That
 *   early return was the only statement of the partition, which is exactly how
 *   the type came to permit what the code did not.
 *
 * **It is a real behaviour change, and the frontend was checked rather than
 * assumed: it sends no `script`, ever.** There is one schedule form in the
 * console (`frontend/src/features/application/advanced/schedules-spec.tsx`), it
 * is the Application one, and its `body()` assembles the payload
 * field-by-field rather than spreading the form — `script` is not a key in it,
 * not `''` and not `undefined`. There is no compose, server or
 * `cloudgate-server` schedule UI at all.
 *
 * `command` was **not** given the same treatment then, and the reason it was
 * not is what a later fix went on to remove: `script` is `.optional()` with no
 * default, so absent means absent and a refusal can tell a client that sent one
 * from a client that did not, while `command` was `.default('')` against a
 * `notNull` column, so the DTO manufactured it for every request and a refusal
 * could not distinguish the two. Now the default is gone — the `''` is
 * minted in `SchedulesService.create`, behind the refusal — and the inert
 * `command` is refused on the two host types exactly as an inert `script` is on
 * the two container ones. The half that stayed asymmetric, and the reasoning
 * for it, is `schedule-inert-command.spec.ts`: `script` refuses the *presence*
 * of the key while `command` refuses a *non-empty* value, because `''` is that
 * column's own resting value.
 *
 * The HTTP shapes, and the `PATCH` half no schema can state, are
 * `schedules.e2e-spec.ts`' *a script a schedule type cannot run*.
 */

describe('scheduleRunsAScript', () => {
  it('partitions every schedule type into one side or the other', () => {
    // The two tuples are the whole classification, and nothing in the type
    // system ties them to the enum, so they can fall out of step with it in
    // silence. A fifth `scheduleType` fails here — before it can be added to
    // the enum, fall into neither tuple, and silently inherit this predicate's
    // `false` along with the refusal that follows from it.
    expect(
      [...CONTAINER_SCHEDULE_TYPES, ...HOST_SCHEDULE_TYPES].sort(),
    ).toEqual([...scheduleTypeEnum.enumValues].sort());
    expect(
      CONTAINER_SCHEDULE_TYPES.filter((type) =>
        (HOST_SCHEDULE_TYPES as readonly string[]).includes(type),
      ),
    ).toEqual([]);

    // And the predicate the three call sites actually branch on, read off the
    // enum rather than off either tuple — so it is the classification that is
    // asserted, not the spelling of it.
    expect(
      Object.fromEntries(
        scheduleTypeEnum.enumValues.map((type) => [
          type,
          scheduleRunsAScript(type),
        ]),
      ),
    ).toEqual({
      application: false,
      compose: false,
      server: true,
      'cloudgate-server': true,
    });
  });
});

describe('createScheduleSchema', () => {
  const container = (extra: Record<string, unknown>) => ({
    name: 'Clear cache',
    cronExpression: '0 3 * * *',
    serviceId: 'app-1',
    command: 'rm -rf /tmp/cache',
    ...extra,
  });

  for (const scheduleType of CONTAINER_SCHEDULE_TYPES) {
    it(`refuses a script on a ${scheduleType} schedule, naming the field`, () => {
      const result = createScheduleSchema.safeParse(
        container({ scheduleType, script: 'apt update' }),
      );

      expect(result.success).toBe(false);
      expect(
        result.error?.issues.map((issue) => [
          issue.path.join('.'),
          issue.message,
        ]),
      ).toEqual([['script', INERT_SCRIPT_REFUSAL]]);
    });

    it(`refuses an empty script on a ${scheduleType} schedule too`, () => {
      // The presence of the key is what is refused, not its content: a client
      // sending `script: ''` has been told the field exists, and telling it so
      // for empty strings only is how the field comes back.
      expect(
        createScheduleSchema.safeParse(container({ scheduleType, script: '' }))
          .success,
      ).toBe(false);
      expect(
        createScheduleSchema.safeParse(
          container({ scheduleType, script: null }),
        ).success,
      ).toBe(false);
    });
  }

  for (const scheduleType of HOST_SCHEDULE_TYPES) {
    it(`takes a script on a ${scheduleType} schedule`, () => {
      const result = createScheduleSchema.safeParse({
        name: 'Update packages',
        cronExpression: '0 6 * * *',
        scheduleType,
        serviceId: 'server-1',
        command: '',
        script: 'apt update',
      });

      expect(result.success).toBe(true);
      expect(result.data).toMatchObject({ scheduleType, script: 'apt update' });
    });
  }

  it('takes a container schedule that carries no script', () => {
    const result = createScheduleSchema.safeParse(
      container({ scheduleType: 'application' }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ scheduleType: 'application' });
  });

  it('still defaults an absent scheduleType to application', () => {
    // The property the union would have cost. Measured: a
    // `z.discriminatedUnion` answers *"Invalid discriminator value"* for this
    // body — legal since the route shipped, and `default: application` in the
    // published `openapi.json` — because the discriminator is matched against
    // the raw input before any arm's `.default()` can run.
    const result = createScheduleSchema.safeParse(container({}));
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ scheduleType: 'application' });
  });

  it('refuses a script on a body that names no scheduleType', () => {
    // The same default, on the path where it decides a refusal: an omitted
    // `scheduleType` is an application schedule, and an application schedule
    // may not carry a script.
    const result = createScheduleSchema.safeParse(
      container({ script: 'apt update' }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.join('.')).toBe('script');
  });

  it('still names an unknown scheduleType rather than blaming a field', () => {
    const result = createScheduleSchema.safeParse(
      container({ scheduleType: 'kubernetes' }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path.join('.')).toBe('scheduleType');
  });
});

describe('updateScheduleSchema', () => {
  it('has no scheduleType to discriminate on, so the refusal is not here', () => {
    // `updateScheduleSchema` deliberately carries no `scheduleType` — a
    // schedule cannot be re-pointed at another target (the backups precedent)
    // — so the type is a fact about the *row*, not about the request, and the
    // DTO cannot decide this one. `SchedulesService.update` answers it against
    // `current.scheduleType`. Asserted rather than described, because "the DTO
    // does not refuse it" is the reason the service has to.
    expect(
      updateScheduleSchema.safeParse({ script: 'apt update' }).success,
    ).toBe(true);
    expect('scheduleType' in updateScheduleSchema.shape).toBe(false);
  });

  it('takes a null script, which is how an inert one is cleared', () => {
    // The remediation for a row that already holds an inert script, and
    // nothing may refuse the write that fixes what it is refusing —
    // `DomainsService.assertParentRowsRoutable`'s own rule, applied here.
    expect(updateScheduleSchema.safeParse({ script: null }).success).toBe(true);
  });
});
