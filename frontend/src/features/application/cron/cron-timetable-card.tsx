import { Banner, BannerRow } from "@/components/console/banner";
import { Card } from "@/components/console/card";
import { KVList, KVRow } from "@/components/console/kv-list";
import type { CronService } from "@/lib/api/endpoints/applications";

/**
 * A Cron service's timetable (ADR-0034): what the config says, and
 * when it fires next. The fields are the config's, so they are read here and
 * changed by a plan, never edited.
 *
 * The next fire times are written in the Cron service's own time zone, the
 * one its `schedule` names clock times in, so `0 3 * * *` reads 03:00 there
 * whichever zone the browser is in. They are the backend's, which skips a
 * clock time that does not exist that day and fires a repeated one once.
 *
 * **Until a build succeeds it fires nothing** — a run starts from the image
 * of the last build that succeeded — and the card says so first, so an
 * empty run history reads as waiting rather than as broken.
 */
export function CronTimetableCard({
  cron,
  actions,
}: {
  cron: CronService;
  /** The card's controls — Run now. */
  actions?: React.ReactNode;
}) {
  const at = new Intl.DateTimeFormat("en-GB", {
    timeZone: cron.timezone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  return (
    <Card>
      <Card.Header
        title="Timetable"
        sub="Set in the Project config; a plan changes it."
        headingLevel={2}
        actions={actions}
      />
      <Card.Body>
        {cron.waitingForFirstBuild ? (
          <Banner icon="clock" title="Waiting for first build">
            <BannerRow
              tone="warn"
              title="Nothing fires until a build succeeds."
              description="Each run starts a fresh container from the image of the last build that succeeded, and there is none yet."
            />
          </Banner>
        ) : null}
        <KVList>
          <KVRow label="Schedule" value={cron.schedule} mono />
          <KVRow label="Time zone" value={cron.timezone} mono />
          <KVRow
            label="Time limit"
            value={cron.timeout}
            title="A run still going at this limit is stopped and counts as failed."
            mono
          />
          <KVRow
            label="Next runs"
            className="items-start"
            value={
              cron.nextFireTimes.length === 0 ? (
                "None"
              ) : (
                <ol className="grid gap-1">
                  {cron.nextFireTimes.map((time) => (
                    <li key={time}>
                      <time dateTime={time}>{at.format(new Date(time))}</time>
                    </li>
                  ))}
                </ol>
              )
            }
          />
        </KVList>
      </Card.Body>
    </Card>
  );
}
