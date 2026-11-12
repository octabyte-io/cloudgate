import { useId } from "react";

import { Card } from "@/components/console/card";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { isRefusal, useRuntimeInfo } from "@/lib/api/use-runtime-info";
import { useArrival } from "@/components/console/use-arrival";

import { SectionFailed, SectionPending } from "../section-states";
import { GROUPS, ROWS, rowsOf } from "./instance-runtime-rows";

/**
 * What the platform host is **actually** running — and which readings are facts
 * about the machine rather than about the process answering.
 *
 * On an instance with zero `Server` rows there was no such screen anywhere.
 * Every observed reading in the console hangs off a `[serverId]` route — a
 * Server's Infrastructure and Docker tabs — and the stock single-host install
 * has none of those, which is exactly the state in which "what is on this
 * machine" has no other answer. An earlier fix dealt with what was *wrong* in
 * that state (an aside pointing at a tab with no route, a card naming a Docker
 * the host is not running) and left the gap underneath open on purpose; this
 * fills it.
 *
 * **It sits beside the fleet aside's declared-only row and does not replace
 * it**, and the reasoning is `fleet-aside.tsx`'s own: that card is titled *What
 * setup installs*, it describes **every** Server in the fleet, and
 * `runtime-info` answers about **one** host — so an observed reading there
 * would present the platform host's version as a fleet-wide fact, "the same
 * category error as the literal it replaces, one level up". This title's
 * grammar is deliberately that title's, and the side is the opposite: what
 * setup installs, against what this host is running. Nothing in `fleet-aside`
 * changes.
 *
 * ## The distinction this card exists to make visible
 *
 * `instance-runtime-rows.ts` holds the fold and the argument for it: every
 * probe carries `scope`, the grouping below is read out of the
 * payload rather than off a list of keys written down here, and `docker.drift`
 * — true on virtually every install and actionable by nobody — is given no
 * declared side at all rather than a warning.
 *
 * What is worth saying *here* is why the grouping is two headings rather than a
 * column of ten rows with a badge on some of them. `Up for` is **41d 6h** for
 * the machine and **2h 00m** for the backend the last update restarted, and the
 * two are one word apart on the same screen. Flattened, that is the original
 * defect drawn as a layout: a confident reading pointing at the wrong machine.
 * So the two uptimes are the last row of each group, and the gloss under each
 * heading says which machine the group is about before any value is read.
 *
 * ## Three branch rules, inherited from `runtime-info.tsx`
 *
 * 1. **A 403 is a role, not a reading.** The route is owner/admin gated, so a
 *    plain member keeps every row and loses only the values. This never becomes
 *    a `SectionFailed`; only a request that actually failed does.
 * 2. **A null `observed` is normal.** A stopped daemon comes back 200 with a
 *    `reason`. That reads "not known" and nothing goes red, because nothing is
 *    known to be wrong. The backend's `reason` stays off screen for the reason
 *    `IngressRow` keeps it off: it is truncated host stderr, written for
 *    whoever reads the logs.
 * 3. **Drift is rendered only where both sides are known and disagree**, which
 *    on this host is Traefik and only Traefik.
 */
export function RuntimeCard() {
  const runtime = useRuntimeInfo(null);
  const headings = useId();
  const refused = isRefusal(runtime);
  const arrival = useArrival(runtime.isPending);

  // §3.5's terminal-state order, with the refusal lifted ahead of the generic
  // error because it is not one: a 403 keeps the whole card and empties the
  // values, and only a request that actually failed replaces the card.
  if (runtime.error && !refused) {
    return (
      <SectionFailed title={TITLE} error={runtime.error}>
        Every row here is one reading off this machine or off the process
        answering, so there is nothing to show when the request itself does not
        land.
      </SectionFailed>
    );
  }
  // Ten, because that is how many readings land — §3.10 sizes a skeleton to
  // the value it replaces so nothing moves on arrival.
  if (runtime.isPending)
    return <SectionPending title={TITLE} rows={ROWS.length} />;

  const rows = rowsOf(runtime.data);

  return (
    <Card className={arrival}>
      <Card.Header
        title={TITLE}
        sub="Read off the machine, and off the process answering."
        headingLevel={2}
      />
      <Card.Body className="grid gap-5">
        {refused ? (
          /*
            One sentence for the whole card rather than `declaredMissingNote`'s
            per-row note repeated ten times. That helper is right for the fleet
            card's two rows and wrong here: ten identical strings down a column
            read as ten separate faults, which is the opposite of what a refusal
            is.
          */
          <p className="text-body text-tx-2">
            Only an owner or an admin can take these readings, so none of them
            was taken. Every row below keeps its name and loses its value —
            nothing here is known to be wrong.
          </p>
        ) : null}

        {GROUPS.map((group) => {
          const mine = rows.filter((row) => row.scope === group.scope);
          // A payload that put everything on one side still renders honestly,
          // rather than leaving a heading standing over nothing.
          if (mine.length === 0) return null;

          return (
            <div key={group.scope}>
              <h3
                id={`${headings}-${group.scope}`}
                className="text-body font-semibold text-tx"
              >
                {group.heading}
              </h3>
              <p className="mt-0.5 text-meta text-tx-3">{group.gloss}</p>
              {/*
                `aria-labelledby` so the list is named by its heading in the
                accessibility tree rather than the pairing being implied by
                which heading it sits under — the same reason `KVList` is a real
                `<dl>`. `data-scope` is what the payload said, and is what the
                spec beside this file asserts the grouping against.
              */}
              <KVList
                className="mt-2"
                aria-labelledby={`${headings}-${group.scope}`}
                data-scope={group.scope}
              >
                {mine.map((row) => (
                  <KVRow
                    key={row.label}
                    label={row.label}
                    // Safe beside the note below because the two never meet:
                    // every row that can carry a drift note has no `mono`.
                    mono={row.mono}
                    value={
                      row.observed === null ? (
                        <Dash word={refused ? "Not read" : "Not known"} />
                      ) : (
                        <span className="flex flex-wrap items-baseline justify-end gap-x-2">
                          <span>{row.observed}</span>
                          {row.drift ? (
                            <span className="text-meta text-tx-3">
                              declared {row.drift}
                            </span>
                          ) : null}
                        </span>
                      )
                    }
                  />
                ))}
              </KVList>
            </div>
          );
        })}
      </Card.Body>
      <Card.Footer>
        A row that is not known was not answered — a daemon that is stopped, or
        a machine with no such binary on it — and is not a failure. Ingress
        names the pinned Traefik version beside the running one only where the
        two differ. Docker shows what is running and nothing beside it: nothing
        pins this machine&rsquo;s Docker, so the version setup installs on a
        Server is not a claim about this one.
      </Card.Footer>
    </Card>
  );
}

/** Named once: the card, its pending shape and its failure all wear it. */
const TITLE = "What this host is running";
