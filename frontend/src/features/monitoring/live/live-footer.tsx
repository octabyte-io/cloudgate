import type { MetricsConfig } from "@/lib/api/endpoints/servers";
import { retentionSpan, type SamplingState } from "@/lib/format/sampling";

/**
 * The footer's one job is to say **which half of the card does what**, because the
 * card deliberately merges two stores for one machine: a socket that ends when this
 * card unmounts, and rows on disk that outlive the browser. The sentence that
 * matters is which of the two raises a notification — the stream never does.
 *
 * A **stopped** history is still a second store, and saying the card "keeps no
 * history you can query" beside the rows it is drawing was a past defect.
 */
export function LiveFooter({
  state,
  config,
  onStopHistory,
}: {
  state: SamplingState;
  /** The stored config, for how long its samples are kept. */
  config: MetricsConfig | null;
  onStopHistory: () => void;
}) {
  const kept = retentionSpan(config);

  if (state === "stopped") {
    return (
      <>
        Two stores, one machine: the reading above is a stream that ends with this
        card, and the stored half is{" "}
        <strong className="font-medium text-tx">stopped</strong> — what it kept
        stays until it is more than {kept} old, and nothing raises a
        threshold notification for this host until it is started again.
      </>
    );
  }

  if (state === "never") {
    return (
      <>
        This is the only live reading in the console and it reaches{" "}
        <strong className="font-medium text-tx">one host</strong>{" "}
        — the machine Cloudgate runs on. As things stand it keeps no history you
        can query and raises no threshold notification. A remote
        Server&rsquo;s history is the card below, which polls its stored samples
        instead.
      </>
    );
  }

  return (
    <>
      <span>
        Two stores, one machine: the reading above is a stream that ends with this
        card, the stored half is rows Cloudgate keeps for {kept} and{" "}
        <strong className="font-medium text-tx">
          the only half that raises a threshold notification
        </strong>
        .
      </span>
      {" · "}
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={onStopHistory}
      >
        Stop keeping a history
      </button>
    </>
  );
}
