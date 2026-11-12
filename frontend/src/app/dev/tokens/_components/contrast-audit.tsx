"use client";

import { contrastOf } from "@/lib/design/contrast";
import { TONE_PILL } from "@/lib/design/status";
import { cn } from "@/lib/utils";
import { PAIRS, TIER_MINIMUM, type Tier } from "../_lib/rows";
import { useMeasured } from "../_lib/use-measured";
import { Mono } from "./section";

type Verdict = "pass" | "fail" | "exempt" | "unread";

function verdictOf(ratio: number | null, tier: Tier): Verdict {
  const minimum = TIER_MINIMUM[tier];
  if (minimum === null) return "exempt";
  if (ratio === null) return "unread";
  return ratio >= minimum ? "pass" : "fail";
}

const VERDICT: Record<Verdict, { word: string; pill: string }> = {
  pass: { word: "pass", pill: TONE_PILL.ok },
  fail: { word: "fail", pill: TONE_PILL.bad },
  exempt: { word: "decoration", pill: TONE_PILL.mute },
  unread: { word: "not measured", pill: TONE_PILL.mute },
};

/**
 * The proof. Reads every pair off the live document, converts it to the sRGB
 * the browser paints, and reports the WCAG ratio — so flipping the theme
 * re-runs the whole audit rather than re-stating an old claim.
 */
export function ContrastAudit() {
  const ratios = useMeasured<(number | null)[] | null>(
    () => PAIRS.map((pair) => contrastOf(pair.fg, pair.bg)),
    null,
  );

  const measured = PAIRS.map((pair, i) => {
    const ratio = ratios?.[i] ?? null;
    return { pair, ratio, verdict: verdictOf(ratio, pair.tier) };
  });

  const required = measured.filter((m) => m.verdict !== "exempt");
  const failing = required.filter((m) => m.verdict !== "pass");
  const exempt = PAIRS.length - required.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span
          className={cn(
            "inline-flex h-pill items-center gap-1.5 rounded-pill border px-2 text-chip",
            ratios === null
              ? TONE_PILL.mute
              : failing.length === 0
                ? TONE_PILL.ok
                : TONE_PILL.bad,
          )}
        >
          <span aria-hidden="true">
            {ratios === null ? "○" : failing.length === 0 ? "●" : "✕"}
          </span>
          {ratios === null
            ? "not measured"
            : failing.length === 0
              ? "all pass"
              : `${failing.length} failing`}
        </span>
        {/* Never state a count the browser has not actually produced: an
            unmeasured audit reading "0 of 27 pass" is a false alarm. */}
        <p className="text-body text-tx-2">
          {ratios === null ? (
            <>
              {required.length} pairs owe a ratio and {exempt} are decoration.
              Nothing is measured until this page runs in a browser.
            </>
          ) : (
            <>
              {required.length - failing.length} of {required.length} pairs that
              owe a ratio clear it in the theme on screen now. {exempt} more are
              decoration and owe nothing.
            </>
          )}
        </p>
      </div>

      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full text-ui">
          <thead>
            <tr className="bg-panel-2 text-left text-ui font-semibold text-tx-2">
              <th scope="col" className="h-thead px-3 font-semibold">
                Pair
              </th>
              <th scope="col" className="h-thead px-3 font-semibold">
                On screen
              </th>
              <th scope="col" className="h-thead px-3 text-right font-semibold">
                Ratio
              </th>
              <th scope="col" className="h-thead px-3 text-right font-semibold">
                Needs
              </th>
              <th scope="col" className="h-thead px-3 font-semibold">
                Verdict
              </th>
            </tr>
          </thead>
          <tbody>
            {measured.map(({ pair, ratio, verdict }) => {
              const minimum = TIER_MINIMUM[pair.tier];
              return (
                <tr
                  key={`${pair.fg}-on-${pair.bg}`}
                  className="border-t border-line align-middle"
                >
                  <td className="h-row px-3">
                    <Mono className="text-tx">{pair.fg}</Mono>
                    <span className="mx-1.5 text-tx-4" aria-hidden="true">
                      /
                    </span>
                    <Mono>{pair.bg}</Mono>
                    {pair.note ? (
                      <span className="ml-2 text-meta text-tx-3">
                        {pair.note}
                      </span>
                    ) : null}
                  </td>
                  <td className="h-row px-3">
                    <span
                      className={cn(
                        "inline-flex h-7 items-center rounded-md border border-line px-2 text-ui whitespace-nowrap",
                        pair.bgClass,
                        pair.fgClass,
                      )}
                    >
                      swarm-prod-2
                    </span>
                  </td>
                  <td className="h-row px-3 text-right">
                    <Mono className="text-tx">
                      {ratio === null ? "—" : `${ratio.toFixed(2)}:1`}
                    </Mono>
                  </td>
                  <td className="h-row px-3 text-right">
                    <Mono>{minimum === null ? "—" : `${minimum}:1`}</Mono>
                  </td>
                  <td className="h-row px-3">
                    <span
                      className={cn(
                        "inline-flex h-pill items-center rounded-pill border px-2 text-chip whitespace-nowrap",
                        VERDICT[verdict].pill,
                      )}
                    >
                      {VERDICT[verdict].word}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
