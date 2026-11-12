import { counted } from "./plural";

/**
 * A cron expression, read back in words.
 *
 * Lives here rather than under `features/application/advanced/` because three
 * features read a schedule back now — an Application's schedules and its volume
 * backups, and a database's backup schedules — and a helper more than one
 * feature imports belongs to none of them. Same move `env-blob.ts` and
 * `units.ts` made into this folder, for the same reason.
 *
 * Deliberately **small and honest**: it recognises the handful of shapes that
 * cover almost every schedule anyone writes by hand, and says
 * "on this cron" for the rest rather than guessing. A half-right reading of
 * `0 0 1-5,15 * 2` is worse than no reading, because it is the one someone would
 * trust instead of reading the expression.
 *
 * No dependency for this. `cron-parser` and friends bring a parser, a scheduler
 * and a timezone database to answer a question these screens ask about five
 * fields — and the reading is a courtesy beside the expression, which is always
 * shown.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return "Not a five-field cron expression";

  const [minute, hour, dayOfMonth, month, weekday] = fields;
  const everyDate = dayOfMonth === "*" && month === "*" && weekday === "*";

  if (minute === "*" && hour === "*" && everyDate) return "Every minute";

  const stepMinutes = step(minute);
  if (stepMinutes && hour === "*" && everyDate) {
    return everyStep(stepMinutes, "minute", "minutes");
  }

  if (isNumber(minute) && hour === "*" && everyDate) {
    return `Hourly, at ${pad(minute)} past`;
  }

  const stepHours = step(hour);
  if (isNumber(minute) && stepHours && everyDate) {
    return `${everyStep(stepHours, "hour", "hours")}, at ${pad(minute)} past`;
  }

  if (isNumber(minute) && isNumber(hour)) {
    const time = `${pad(hour)}:${pad(minute)}`;
    if (everyDate) return `Every day at ${time}`;
    if (dayOfMonth === "*" && month === "*" && DAYS[weekday]) {
      return `Every ${DAYS[weekday]} at ${time}`;
    }
    if (isNumber(dayOfMonth) && month === "*" && weekday === "*") {
      return `On day ${dayOfMonth} of every month at ${time}`;
    }
    return `At ${time}, on this cron`;
  }

  return "On this cron";
}

const DAYS: Record<string, string> = {
  "0": "Sunday",
  "1": "Monday",
  "2": "Tuesday",
  "3": "Wednesday",
  "4": "Thursday",
  "5": "Friday",
  "6": "Saturday",
  "7": "Sunday",
};

const isNumber = (field: string) => /^\d+$/.test(field);
const pad = (field: string) => field.padStart(2, "0");

/**
 * `Every 5 minutes` — and `Every minute` when the step is 1.
 *
 * A step of 1 is a legal, and common, way to write `*`, and a schedule written
 * that way read **"Every 1 minutes"**
 * the plural was
 * spelled out and the numeral it had to agree with was never looked at. The
 * agreement comes from `counted` in `plural.ts` rather than an inline ternary,
 * which is that module's whole purpose (§1.4).
 *
 * The singular branch is not `counted(1, …)`, and that is the point of the
 * function. `counted` would give "Every 1 minute", which is grammatical and
 * still wrong: English drops the numeral entirely at one, and a stepped
 * every-minute expression has to read as the *same string* the bare `* * * * *`
 * already gets, or two spellings of one schedule read as two schedules.
 */
function everyStep(count: string, noun: string, plural: string): string {
  if (count === "1") return `Every ${noun}`;
  return `Every ${counted(Number(count), noun, plural)}`;
}

/** A step field such as "every 15" → `15`, and nothing for anything else. */
function step(field: string): string | null {
  const match = /^\*\/(\d+)$/.exec(field);
  return match ? match[1] : null;
}
