"use client";

import { KVList, KVRow } from "@/components/console/kv-list";
import { Meter } from "@/components/console/meter";
import { QAList, QARow } from "@/components/console/qa-row";
import { SegmentedProgress } from "@/components/console/segmented-progress";
import { Sparkline } from "@/components/console/sparkline";
import { SplitBar } from "@/components/console/split-bar";
import { StatGrid, StatTile } from "@/components/console/stat-tile";
import { Button } from "@/components/ui/button";
import { Icon } from "@/lib/design/icons";
import { Switch } from "@/components/ui/switch";
import { CPU_SERIES } from "../_lib/fixtures";
import { Row } from "../../_components/shell";

const IMAGE =
  "sha256:9f2c4d1ab7e35c08f4a6d29b1e7c5083af61b2d4c9e08715a3f6b2c1d8e94750";

/** Twelve Swarm services, seven updated, one updating. */
const STEPS = [
  "storefront",
  "checkout-api",
  "search-indexer",
  "media-transcoder",
  "webhooks-gateway",
  "reporting-worker",
  "postgres-primary",
  "redis-cache",
  "minio",
  "traefik",
  "prometheus",
  "loki",
].map((label, index) => ({
  id: label,
  label,
  state: index < 7 ? ("done" as const) : index === 7 ? ("now" as const) : ("todo" as const),
}));

const gb = (value: number) => `${value.toFixed(1)} GB`;

export function ReadoutsGallery() {
  return (
    <>
      <Row
        label="StatTile / StatGrid"
        note="Two columns, one wide tile, one live figure with its history under it. Figures are proportional unless they tick in place."
        className="block"
      >
        <StatGrid className="w-full max-w-aside">
          <StatTile label="Applications" value="24" detail="6 idle" />
          <StatTile label="Servers" value="7" detail="all active" />
          <StatTile
            label="Deployments today"
            value="38"
            detail="7 failed, 2 cancelled"
            info
          />
          <StatTile label="Build minutes" value="412" unit="min" detail="in August" />
          <StatTile
            wide
            live
            label="CPU across the fleet"
            value="62"
            unit="%"
            detail="mean of 7 Servers, last 24 hours"
            trend={
              <Sparkline
                label="Fleet CPU, last 24 hours"
                values={CPU_SERIES}
                format={(value) => `${value}%`}
              />
            }
          />
        </StatGrid>
      </Row>

      <Row
        label="KVList / KVRow"
        note="The facts about one thing. The value is right-aligned and truncates, so a 71-character digest cannot widen the rail it lives in — the whole string is in the tooltip."
        className="block"
      >
        <KVList className="w-full max-w-aside">
          <KVRow
            label="Image"
            mono
            value={IMAGE}
            title={IMAGE}
            action={
              <Button size="icon-xs" variant="qt">
                <Icon name="copy" size={14} label="Copy image digest" />
              </Button>
            }
          />
          <KVRow label="Created" value="3 August 2026, 14:22" />
          <KVRow label="Server" value="manager-1" />
          <KVRow label="Host" mono value="storefront.acme.example.com" />
          <KVRow label="Port" mono value="3000/tcp" />
          <KVRow
            label="Restart policy"
            value="on-failure, 3 attempts"
            action={
              <Button size="icon-xs" variant="qt">
                <Icon name="pencil" size={14} label="Edit restart policy" />
              </Button>
            }
          />
        </KVList>
      </Row>

      <Row
        label="QAList / QARow"
        note="What to do next, why, and the control that does it."
        className="block"
      >
        <QAList className="w-full max-w-lede">
          <QARow
            title="Give checkout-api a health check"
            description="Swarm has no way to tell a started container from a working one, so a bad Deployment stays in the rotation."
            link={{ label: "How health checks work", href: "#main" }}
            action={<Button size="sm">Add one</Button>}
          />
          <QARow
            title="Turn on automatic rollback"
            description="A Deployment whose tasks never reach running rolls back to the last one that did."
            action={
              <Switch defaultChecked aria-label="Automatic rollback" />
            }
          />
        </QAList>
      </Row>

      <Row
        label="Meter"
        note="Four tones. warn and alarm always carry a word — a red bar is red only to someone who can see red."
        className="grid w-full max-w-aside grid-cols-1 gap-4"
      >
        <Meter label="Disk" value="18.2 of 40 GB" percent={46} />
        <Meter
          label="Disk on manager-1"
          value="34.1 of 40 GB"
          percent={85}
          tone="warn"
          note="6 GB left — a build needs about 4"
        />
        <Meter
          label="Memory on worker-3"
          value="15.6 of 16 GB"
          percent={98}
          tone="alarm"
        />
        <Meter
          label="CPU on worker-4"
          value="not reporting"
          percent={0}
          tone="mute"
          note="No stats since 14:02"
        />
      </Row>

      <Row
        label="SegmentedProgress"
        note="The companion to a Meter: the meter says how far along, this says which step. Hover a segment for its name; a screen reader gets the sentence."
        className="block"
      >
        <div className="w-full max-w-aside">
          <Meter label="Updating stack" value="7 of 12 services" percent={62} />
          <SegmentedProgress
            className="mt-2"
            label="Updating acme-production"
            noun="service"
            steps={STEPS}
          />
        </div>
      </Row>

      <Row
        label="SplitBar"
        note="A total split by its parts, never against an invented quota — the total is the sum. The legend is not optional: it is where identity and the numbers live."
        className="grid w-full max-w-aside grid-cols-1 gap-5"
      >
        <SplitBar
          label="Disk used by Docker on manager-1"
          format={gb}
          parts={[
            { id: "images", label: "Images", value: 21.4 },
            { id: "volumes", label: "Volumes", value: 9.1 },
            { id: "containers", label: "Containers", value: 2.6 },
            { id: "cache", label: "Build cache", value: 5.2 },
          ]}
        />
        <SplitBar
          label="Deployments this week"
          parts={[
            { id: "done", label: "storefront", value: 41 },
            { id: "api", label: "checkout-api", value: 22 },
            { id: "idx", label: "search-indexer", value: 9 },
            { id: "media", label: "media-transcoder", value: 6 },
            { id: "rest", label: "Other", value: 12 },
          ]}
        />
      </Row>
    </>
  );
}
