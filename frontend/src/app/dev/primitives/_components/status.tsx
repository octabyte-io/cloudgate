import { Chip } from "@/components/console/chip";
import { Dot } from "@/components/console/dot";
import { GutterMark } from "@/components/console/gutter-mark";
import { StatusPill } from "@/components/console/status-pill";
import {
  containerMark,
  CONTAINER_STATE,
  GUT,
  STATUS,
  TASK_STATE,
  taskMark,
  type ChangeKey,
  type StatusKey,
} from "@/lib/design/status";
import { Row } from "./shell";

const STATUS_KEYS = Object.keys(STATUS) as StatusKey[];
const CHANGE_KEYS = Object.keys(GUT) as ChangeKey[];

export function StatusGallery() {
  return (
    <>
      <Row
        label="StatusPill — our three enums"
        note="applicationStatus, deployment.status, serverStatus. Nothing else exists."
      >
        {STATUS_KEYS.map((key) => (
          <StatusPill key={key} status={key} />
        ))}
      </Row>

      <Row
        label="StatusPill — Docker's container states"
        note="third-party words, resolved from free text off an SSH pipe"
      >
        {Object.keys(CONTAINER_STATE).map((state) => (
          <StatusPill key={state} mark={containerMark(state)} />
        ))}
        <StatusPill mark={containerMark("some-state-docker-added")} />
      </Row>

      <Row
        label="StatusPill — Swarm task states"
        note="ready means assigned and about to start, not healthy"
      >
        {Object.keys(TASK_STATE).map((state) => (
          <StatusPill key={state} mark={taskMark(state)} />
        ))}
      </Row>

      <Row label="Dot" note="every one carries its word in an sr-only span">
        {STATUS_KEYS.map((key) => (
          <span key={key} className="inline-flex items-center gap-2 text-ui text-tx-2">
            <Dot status={key} />
            {key}
          </span>
        ))}
      </Row>

      <Row label="Chip" note="a label, never a status">
        <Chip>Production</Chip>
        <Chip variant="mono">2f9c1ab</Chip>
        <Chip variant="mono">:8080 → :3000</Chip>
        <Chip variant="brand">Default Environment</Chip>
        <Chip>
          <span aria-hidden="true">↑</span> 3 replicas
        </Chip>
      </Row>

      <Row label="GutterMark" note="the signed change column in a plan or a diff">
        <div className="rounded-lg border border-line bg-panel-2 px-3 py-2 font-mono text-ui">
          {CHANGE_KEYS.map((key) => (
            <div key={key} className="flex items-center gap-3">
              <GutterMark change={key} />
              <span className="text-tx-2">{GUT[key].label}</span>
            </div>
          ))}
        </div>
      </Row>
    </>
  );
}
