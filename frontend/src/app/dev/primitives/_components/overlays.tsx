"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { Field } from "@/components/console/field";
import { Menu, MenuRow } from "@/components/console/menu";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/lib/api/api-error";
import { Icon } from "@/lib/design/icons";
import { Row } from "./shell";

export function OverlaysGallery() {
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);

  return (
    <>
      <Row label="Menu — anchored, with labels, separators and a destructive row">
        <Menu
          trigger={
            <Button variant="gh">
              <Icon name="cog" />
              Manage
              <Icon name="chevD" className="text-tx-3" />
            </Button>
          }
        >
          <Menu.Group label="This Application">
            <Menu.Item icon="rocket">Deploy</Menu.Item>
            <Menu.Item icon="refresh">Redeploy the last build</Menu.Item>
            <Menu.Item icon="term" chevron>
              Open a terminal
            </Menu.Item>
          </Menu.Group>
          <Menu.Separator />
          <Menu.Group label="Environment">
            <Menu.Item icon="check" selected>
              production
            </Menu.Item>
            <Menu.Item icon="layers">staging</Menu.Item>
          </Menu.Group>
          <Menu.Separator />
          <Menu.Item icon="trash" destructive>
            Delete this Application
          </Menu.Item>
        </Menu>

        <Menu
          trigger={
            <Button variant="qt" size="icon" aria-label="More actions">
              <Icon name="sliders" />
            </Button>
          }
        >
          <Menu.Item icon="copy">Copy the Application id</Menu.Item>
          <Menu.Item icon="ext">Open in a new tab</Menu.Item>
        </Menu>
      </Row>

      <Row
        label="The same row, on a card"
        note="the reference leaves .mi unscoped so a menu row and a compact list row cannot drift apart"
        className="block"
      >
        <Card tone="plain" className="max-w-80">
          <Card.Header title="Quick links" />
          <Card.Body className="flex flex-col gap-0.5 p-1.5">
            <MenuRow icon="branch" chevron>
              octabyte/checkout-api
            </MenuRow>
            <MenuRow icon="globe" chevron>
              checkout.example.com
            </MenuRow>
            <MenuRow icon="trash" destructive>
              Disconnect the repository
            </MenuRow>
          </Card.Body>
        </Card>
      </Row>

      <Row label="Modal — scrolls inside the box, never the page">
        <Button
          variant="gh"
          onClick={() => {
            setWide(false);
            setOpen(true);
          }}
        >
          Open a Modal
        </Button>
        <Button
          variant="gh"
          onClick={() => {
            setWide(true);
            setOpen(true);
          }}
        >
          Open a wide Modal
        </Button>
      </Row>

      <Modal open={open} onOpenChange={setOpen} wide={wide}>
        <Modal.Header
          title="Delete checkout-api"
          description="This removes the Application, its Deployments and its build logs. The Servers it runs on are not touched."
        />
        <Modal.Body>
          <Field
            name="confirm"
            label="Type the Application's name to confirm"
            hint="checkout-api"
          >
            <Input placeholder="checkout-api" />
          </Field>
          <p className="text-body text-tx-2">
            Everything below is filler, so the box has something to scroll.
          </p>
          {Array.from({ length: 8 }, (_, index) => (
            <p key={index} className="text-body text-tx-2">
              A Deployment builds an Application and rolls it onto its Servers.
              Deleting the Application does not roll anything back — containers
              already running keep running until the Server is reconciled.
            </p>
          ))}
        </Modal.Body>
        <Modal.Footer>
          <span className="text-meta text-tx-3">This cannot be undone.</span>
          <Modal.Gap />
          <Modal.Close render={<Button variant="gh" />}>Keep it</Modal.Close>
          <Button
            variant="dngr"
            onClick={() => {
              setOpen(false);
              toast.done("Deleted checkout-api.", {
                description: "Its Deployments and build logs went with it.",
              });
            }}
          >
            Delete this Application
          </Button>
        </Modal.Footer>
      </Modal>

      <Row
        label="toast — error takes the error, never a pre-formatted string"
        note="every failure goes through errorMessage(), so .message never reaches a screen"
      >
        <Button variant="gh" size="sm" onClick={() => toast.done("Deployed checkout-api.")}>
          done
        </Button>
        <Button
          variant="gh"
          size="sm"
          onClick={() => toast.info("Two Applications have no health check.")}
        >
          info
        </Button>
        <Button
          variant="gh"
          size="sm"
          onClick={() => toast.warn("Deployed, but the health check has not passed yet.")}
        >
          warn
        </Button>
        <Button
          variant="gh"
          size="sm"
          onClick={() => toast.error(new ApiError(403, "Forbidden resource"))}
        >
          error — a 403
        </Button>
        <Button
          variant="gh"
          size="sm"
          onClick={() => toast.error(new TypeError("Failed to fetch"))}
        >
          error — backend down
        </Button>
      </Row>
    </>
  );
}
