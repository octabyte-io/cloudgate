/**
 * What the Overview's failed-build banner says of a Cron service
 * (US38), in place of a web service's "still serving traffic": a Cron service
 * serves nothing and keeps no task running. Each run starts a fresh container
 * from the image of the last build that succeeded, so a failed build changes
 * no run — unless none has succeeded, when nothing fires at all.
 */
export function cronAfterFailure(waitingForFirstBuild: boolean): {
  title: string;
  description: string;
} {
  return waitingForFirstBuild
    ? {
        title: "This Cron service is waiting for its first build.",
        description:
          "No build of it has succeeded yet, so its timetable fires nothing: there is no image to start a run from. Read the output below, fix the cause, and build it again.",
      }
    : {
        title: "Its runs still start from the last build that succeeded.",
        description:
          "A failed build changes nothing a run starts from. Read the output below, fix the cause, and build it again.",
      };
}
