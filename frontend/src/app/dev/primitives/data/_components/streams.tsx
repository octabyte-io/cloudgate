"use client";

import * as React from "react";

import { DiffView } from "@/components/console/diff-view";
import { LogWell, type LogLine } from "@/components/console/log-well";
import { Button } from "@/components/ui/button";
import { BUILD_LOG, COMPOSE_DIFF } from "../_lib/fixtures";
import { Row } from "../../_components/shell";

const TONES: LogLine[] = [
  { ts: "14:22:07", text: "#7 [7/9] RUN pnpm build", tone: "hl" },
  { ts: "14:22:41", text: "  Compiled successfully in 41.2s", tone: "ok" },
  {
    ts: "14:22:42",
    text: " WARN  the lockfile is out of date with package.json for @acme/design@1.2.0",
    tone: "warn",
  },
  {
    ts: "14:22:44",
    text: "ECONNRESET while fetching https://registry.npmjs.org/@acme%2fdesign — retrying (1/3)",
    tone: "bad",
  },
  { ts: "14:22:45", text: "  retry 1 of 3 in 500ms", tone: "dim" },
  {
    ts: "14:22:46",
    text: "  no tone at all: registry.octabyte.io/acme/storefront@sha256:9f2c4d1ab7e35c08f4a6d29b1e7c5083af61b2d4c9e08715a3f6b2c1d8e94750 — a line with nowhere to break, wrapped rather than scrolled",
  },
];

export function StreamsGallery() {
  const [extra, setExtra] = React.useState<LogLine[]>([]);
  const [following, setFollowing] = React.useState(true);

  function write() {
    setExtra((current) => [
      ...current,
      ...Array.from({ length: 20 }, (_, index) => ({
        ts: "14:47:" + String((index * 3) % 60).padStart(2, "0"),
        text: `  appended line ${current.length + index + 1} — scroll up while writing and the well lets go of the tail`,
      })),
    ]);
  }

  return (
    <>
      <Row
        label="LogWell"
        note="500 lines, a live tail cursor, and 1,003 lines already dropped off the front of the buffer. Write more, then scroll up: following detaches, and there is a way back."
        className="block"
      >
        <div className="w-full">
          <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
            <Button size="sm" onClick={write}>
              Write 20 lines
            </Button>
            <p className="text-meta text-tx-3">
              Following: <strong className="text-tx">{String(following)}</strong>{" "}
              · {BUILD_LOG.length + extra.length} lines held
            </p>
          </div>
          <LogWell
            label="Deployment output for storefront"
            lines={[...BUILD_LOG, ...extra]}
            dropped={1003}
            live
            stamp="14:47:09"
            following={following}
            onFollowingChange={setFollowing}
          />
        </div>
      </Row>

      <Row
        label="LogWell, every tone"
        note="ok, warn, bad, highlight, dim — and a plain line holding an image digest, to show that a long line wraps rather than sending the well sideways. The well is near-black in both themes: that is the one place the light palette borrows from the dark one."
        className="block"
      >
        <LogWell
          className="w-full"
          label="Log line tones"
          lines={TONES}
        />
      </Row>

      <Row
        label="DiffView"
        note="Adds, deletes and unchanged context, with a sticky gutter. Diff lines cannot wrap without lying about their indentation, so this one scrolls sideways inside itself — try the long DATABASE_URL."
        className="block"
      >
        <DiffView
          className="w-full"
          label="docker-compose.yml, pending changes"
          rows={COMPOSE_DIFF}
        />
      </Row>
    </>
  );
}
