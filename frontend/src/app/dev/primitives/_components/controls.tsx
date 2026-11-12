"use client";

import { useState } from "react";

import { SearchInput } from "@/components/console/search-input";
import { Segmented } from "@/components/console/segmented";
import { Tabs } from "@/components/console/tabs";
import { Toolbar, ToolbarGap } from "@/components/console/toolbar";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Icon } from "@/lib/design/icons";
import { Row } from "./shell";

const VARIANTS = ["pri", "gh", "qt", "dngr"] as const;
const SIZES = ["default", "sm", "xs"] as const;

export function ControlsGallery() {
  const [scope, setScope] = useState<"all" | "running" | "failed">("all");
  const [query, setQuery] = useState("");
  const [on, setOn] = useState(true);

  return (
    <>
      <Row
        label="Button — every variant, at every size"
        note="pri is the one action on a screen; gh is the default"
      >
        <div className="flex flex-col gap-2.5">
          {SIZES.map((size) => (
            <div key={size} className="flex flex-wrap items-center gap-2.5">
              <span className="w-14 font-mono text-meta text-tx-3">{size}</span>
              {VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size={size}>
                  <Icon name="rocket" size={size === "xs" ? 13 : 16} />
                  Deploy
                </Button>
              ))}
            </div>
          ))}
        </div>
      </Row>

      <Row
        label="Button — inert"
        note="aria-disabled, not disabled: still focusable, still explainable, click swallowed"
      >
        {VARIANTS.map((variant) => (
          <Button key={variant} variant={variant} disabled>
            Deploy
          </Button>
        ))}
        <Button variant="gh" size="icon" aria-label="Refresh">
          <Icon name="refresh" />
        </Button>
        <Button variant="gh" size="icon-sm" aria-label="Copy">
          <Icon name="copy" />
        </Button>
        <Button variant="gh" size="icon-xs" aria-label="Close">
          <Icon name="x" />
        </Button>
      </Row>

      <Row label="Toolbar — search, segmented, actions" className="block">
        <Toolbar>
          <SearchInput
            label="Search Applications"
            placeholder="Search Applications"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <Segmented
            label="Which Applications to show"
            options={[
              { value: "all", label: "All" },
              { value: "running", label: "Running" },
              { value: "failed", label: "Failed" },
            ]}
            value={scope}
            onChange={setScope}
          />
          <ToolbarGap />
          <Button variant="gh">
            <Icon name="filter" />
            Filter
          </Button>
          <Button variant="pri">
            <Icon name="plus" />
            New Application
          </Button>
        </Toolbar>
      </Row>

      <Row label="Tabs — scroll sideways, never widen the page" className="block">
        <Tabs defaultValue="overview">
          <Tabs.Bar>
            {[
              "Overview",
              "Deployments",
              "Logs",
              "Environment",
              "Domains",
              "Storage",
              "Health checks",
              "Advanced",
            ].map((tab) => (
              <Tabs.Tab key={tab} value={tab.toLowerCase()}>
                {tab}
              </Tabs.Tab>
            ))}
          </Tabs.Bar>
          <Tabs.Panel value="overview" className="text-body text-tx-2">
            The panel a tab controls. Each one is its own file in a feature
            phase.
          </Tabs.Panel>
          {["deployments", "logs", "environment", "domains", "storage", "health checks", "advanced"].map(
            (value) => (
              <Tabs.Panel key={value} value={value} className="text-body text-tx-2">
                {value}
              </Tabs.Panel>
            ),
          )}
        </Tabs>
      </Row>

      <Row label="Text input, switch and checkbox" note="shadcn's, on our geometry">
        <Input placeholder="my-application" className="max-w-60" />
        <Input placeholder="my-application" className="max-w-60" disabled />
        <Input
          placeholder="my-application"
          className="max-w-60"
          aria-invalid
          defaultValue="My Application"
        />
        <Label className="text-body text-tx">
          <Switch checked={on} onCheckedChange={setOn} />
          Deploy on push
        </Label>
        <Label className="text-body text-tx">
          <Switch disabled />
          Deploy on push
        </Label>
        <Label className="text-body text-tx">
          <Checkbox defaultChecked />
          Force rebuild
        </Label>
        <Label className="text-body text-tx">
          <Checkbox disabled />
          Force rebuild
        </Label>
      </Row>
    </>
  );
}
