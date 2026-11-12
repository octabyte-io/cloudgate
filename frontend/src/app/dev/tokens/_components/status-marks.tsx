import {
  CHANGE_TEXT,
  CONTAINER_STATE,
  GUT,
  STATUS,
  TASK_STATE,
  TONE_FILL,
  TONE_PILL,
  type ChangeMark,
  type Mark,
} from "@/lib/design/status";
import { cn } from "@/lib/utils";
import { Label, Mono } from "./section";

/**
 * The pill, the dot and the gutter mark, rendered here to prove the one rule
 * that governs all three: the glyph is `aria-hidden`, and the word is always
 * present — visibly in a pill, in an `sr-only` span beside a bare dot. F03 owns
 * the real components; these are the reference they are built against.
 */
function Pill({ mark }: { mark: Mark }) {
  return (
    <span
      className={cn(
        "inline-flex h-pill items-center gap-1.5 rounded-pill border px-2 pl-1.5 text-chip whitespace-nowrap",
        TONE_PILL[mark.tone],
      )}
    >
      <span aria-hidden="true">{mark.glyph}</span>
      {mark.label}
    </span>
  );
}

function Dot({ mark }: { mark: Mark }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn("size-2 rounded-pill", TONE_FILL[mark.tone])}
        aria-hidden="true"
      />
      <span className="sr-only">{mark.label}</span>
      <Mono className="text-tx-3">sr-only: “{mark.label}”</Mono>
    </span>
  );
}

function Gutter({ mark }: { mark: ChangeMark }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        className={cn(
          "font-mono text-body font-semibold",
          CHANGE_TEXT[mark.tone],
        )}
        aria-hidden="true"
      >
        {mark.glyph}
      </span>
      <span className="sr-only">{mark.label}</span>
      <span className="text-ui text-tx-2">{mark.label}</span>
    </span>
  );
}

function Row({
  title,
  provenance,
  children,
}: {
  title: string;
  provenance: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4 first:border-0 first:pt-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Label>{title}</Label>
        <Mono wrap className="text-tx-3">
          {provenance}
        </Mono>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {children}
      </div>
    </div>
  );
}

export function StatusMarks() {
  return (
    <div className="flex flex-col gap-4">
      <Row title="Our statuses" provenance="applicationStatus · deployment.status · serverStatus">
        {Object.entries(STATUS).map(([key, mark]) => (
          <Pill key={key} mark={mark} />
        ))}
      </Row>

      <Row title="Docker container states" provenance="docker ps --format {{.State}}">
        {Object.entries(CONTAINER_STATE).map(([key, mark]) => (
          <Pill key={key} mark={mark} />
        ))}
      </Row>

      <Row title="Swarm task states" provenance="docker service ps --format {{.DesiredState}}">
        {Object.entries(TASK_STATE).map(([key, mark]) => (
          <Pill key={key} mark={mark} />
        ))}
      </Row>

      <Row
        title="The same statuses as bare dots"
        provenance="hue alone says nothing — the word rides along for a screen reader"
      >
        {Object.entries(STATUS).map(([key, mark]) => (
          <Dot key={key} mark={mark} />
        ))}
      </Row>

      <Row
        title="Change gutter"
        provenance="a change type and a status are different vocabularies"
      >
        {Object.entries(GUT).map(([key, mark]) => (
          <Gutter key={key} mark={mark} />
        ))}
      </Row>
    </div>
  );
}
