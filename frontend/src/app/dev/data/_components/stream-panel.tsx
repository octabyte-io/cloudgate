"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useDeploymentLog } from "@/lib/realtime/gateways";

import { Failure, Panel, Row } from "./panel";

/**
 * Proves one gateway live. `/listen-deployment` is the honest test of the whole
 * socket layer: `tail -n +1 -f` replays what the build has already written and
 * then follows, so the stream has to handle both a burst and a trickle, and the
 * clean close when `tail` reaches the end of a finished build.
 *
 * It follows a Deployment that already exists, by the id pasted below. It used
 * to make one: a button that created a Project, an
 * Environment and an Application and deployed it, in whatever Organization the
 * reader was signed in to, one press per probe. A harness page is not
 * where infrastructure should be born, and `dev-pages-write-nothing.test.ts`
 * keeps it that way.
 */
export function StreamPanel() {
  const [deploymentId, setDeploymentId] = useState<string | null>(null);

  const stream = useDeploymentLog({ deploymentId });

  return (
    <Panel
      title="Deployment log stream"
      blurb="Paste the id of a Deployment and follow its log over /listen-deployment. The socket is addressed by deployment id — the gateway resolves the log file and the machine holding it from the row."
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" onClick={stream.clear}>
          Clear buffer
        </Button>
        <Button variant="outline" onClick={stream.reconnect}>
          Reconnect
        </Button>
        <Button
          variant="outline"
          onClick={() => stream.setFollowing(!stream.following)}
        >
          {stream.following ? "Stop following tail" : "Follow tail"}
        </Button>
      </div>

      <label className="flex flex-col gap-1 text-ui text-tx-3">
        deploymentId
        <input
          value={deploymentId ?? ""}
          onChange={(event) => setDeploymentId(event.target.value || null)}
          placeholder="Paste the id of a Deployment that already exists"
          className="h-ctl rounded-lg border border-line bg-ground px-2.5 font-mono text-meta text-tx"
        />
      </label>

      <Row label="Socket status">{stream.status}</Row>
      <Row label="Following tail">{String(stream.following)}</Row>
      <Row label="Lines">{stream.lines.length}</Row>
      <Row label="Dropped to stay under the cap">{stream.dropped}</Row>
      {stream.closeReason ? (
        <Failure message={`The gateway refused this: ${stream.closeReason}`} />
      ) : null}

      <div className="max-h-72 overflow-auto rounded-lg bg-well p-3">
        {stream.lines.length === 0 ? (
          <p className="font-mono text-meta text-well-tx opacity-70">
            Nothing on the wire yet.
          </p>
        ) : (
          stream.lines.map((line, index) => (
            <p
              // Lines repeat, and the buffer is append-only — position is the
              // only stable identity a log line has.
              key={`${index}-${line}`}
              className="font-mono text-meta whitespace-pre-wrap text-well-tx"
            >
              {line}
            </p>
          ))
        )}
      </div>
    </Panel>
  );
}
